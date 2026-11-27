//! `drawingN.xml` reader: anchors, pictures, shapes (preset and custom
//! geometry), text bodies and group transforms.

use super::*;

/// xdr:txBody paragraphs with per-run styling; a:br becomes a newline run.
pub(crate) fn parse_text_paragraphs(
    body: Node<'_, '_>,
    colors: &ColorContext,
) -> Vec<ShapeParagraph> {
    body.children()
        .filter(|node| node.has_tag_name("p"))
        .map(|paragraph| {
            let properties = direct_child(paragraph, "pPr");
            let align = properties
                .and_then(|node| node.attribute("algn"))
                .map(ToOwned::to_owned);
            let emu_points = |name: &str| {
                properties
                    .and_then(|node| node.attribute(name))
                    .and_then(|value| value.parse::<f64>().ok())
                    .map(|value| value / 12700.0)
            };
            let auto_num = properties.and_then(|node| direct_child(node, "buAutoNum"));
            let bullet_char = properties
                .and_then(|node| direct_child(node, "buChar"))
                .and_then(|node| node.attribute("char"))
                .filter(|value| !value.is_empty())
                .map(ToOwned::to_owned);
            let mut runs = Vec::new();
            for child in paragraph.children() {
                if child.has_tag_name("br") {
                    runs.push(ShapeRun {
                        text: "\n".into(),
                        color: None,
                        bold: false,
                        italic: false,
                        underline: false,
                        size: None,
                        caps: None,
                    });
                    continue;
                }
                if !child.has_tag_name("r") {
                    continue;
                }
                let text = direct_child(child, "t")
                    .and_then(|node| node.text())
                    .unwrap_or_default()
                    .to_owned();
                let properties = direct_child(child, "rPr");
                let flag = |name: &str| {
                    properties
                        .and_then(|rpr| rpr.attribute(name))
                        .is_some_and(|value| value == "1" || value == "true")
                };
                runs.push(ShapeRun {
                    text,
                    color: properties.and_then(|rpr| drawing_fill_color(rpr, colors)),
                    bold: flag("b"),
                    italic: flag("i"),
                    underline: properties
                        .and_then(|rpr| rpr.attribute("u"))
                        .is_some_and(|value| value != "none"),
                    size: properties
                        .and_then(|rpr| rpr.attribute("sz"))
                        .and_then(|value| value.parse::<f64>().ok())
                        .map(|value| value / 100.0),
                    caps: properties
                        .and_then(|rpr| rpr.attribute("cap"))
                        .filter(|value| *value == "all" || *value == "small")
                        .map(ToOwned::to_owned),
                });
            }
            ShapeParagraph {
                align,
                margin_left: emu_points("marL"),
                indent: emu_points("indent"),
                bullet_scheme: auto_num
                    .map(|node| node.attribute("type").unwrap_or("arabicPeriod").to_owned()),
                bullet_start_at: auto_num
                    .and_then(|node| node.attribute("startAt"))
                    .and_then(|value| value.parse::<u32>().ok()),
                bullet_char: if auto_num.is_some() {
                    None
                } else {
                    bullet_char
                },
                runs,
            }
        })
        .collect()
}

const DRAWINGML_MAIN: &str = "http://schemas.openxmlformats.org/drawingml/2006/main";
const STRICT_DRAWINGML_MAIN: &str = "http://purl.oclc.org/ooxml/drawingml/main";
const SVG_BLIP_NS: &str = "http://schemas.microsoft.com/office/drawing/2016/SVG/main";

fn drawing_main_children<'a, 'input>(
    parent: Node<'a, 'input>,
    tag: &'static str,
) -> impl Iterator<Item = Node<'a, 'input>> {
    parent.children().filter(move |child| {
        child.has_tag_name(tag)
            && matches!(child.tag_name().namespace(), Some(DRAWINGML_MAIN | STRICT_DRAWINGML_MAIN))
    })
}

fn picture_blip<'a, 'input>(picture: Node<'a, 'input>) -> Option<Node<'a, 'input>> {
    let fill = picture.children().find(|child| {
        child.has_tag_name("blipFill") && child.tag_name().namespace() == picture.tag_name().namespace()
    });
    drawing_main_children(fill.unwrap_or(picture), "blip").next()
}

fn is_image_relationship(relationship: &Relationship) -> bool {
    relationship.relationship_type.rsplit('/').next() == Some("image")
}

fn drawing_image_path(drawing_path: &str, relationship: &Relationship) -> Option<String> {
    if relationship.external || !is_image_relationship(relationship) {
        return None;
    }
    let path = resolve_part_target(drawing_path, &relationship.target).ok()?;
    media_type_for_path(&path)?;
    Some(path)
}

fn embedded_drawing_image(
    node: Node<'_, '_>,
    drawing_path: &str,
    relationships: &HashMap<String, Relationship>,
) -> Option<String> {
    let mut ids = node.attributes().filter(|attribute| {
        attribute.name() == "embed"
            && matches!(
                attribute.namespace(),
                Some("http://schemas.openxmlformats.org/officeDocument/2006/relationships"
                    | "http://purl.oclc.org/ooxml/officeDocument/relationships")
            )
    });
    let id = ids.next()?.value();
    if ids.next().is_some() {
        return None;
    }
    drawing_image_path(drawing_path, relationships.get(id)?)
}

fn blip_media_path(
    blip: Node<'_, '_>,
    drawing_path: &str,
    relationships: &HashMap<String, Relationship>,
) -> Option<String> {
    embedded_drawing_image(blip, drawing_path, relationships).or_else(|| {
        drawing_main_children(blip, "extLst")
            .flat_map(|list| drawing_main_children(list, "ext"))
            .flat_map(|extension| extension.children())
            .filter(|node| node.has_tag_name((SVG_BLIP_NS, "svgBlip")))
            .filter_map(|node| embedded_drawing_image(node, drawing_path, relationships))
            .find(|path| media_type_for_path(path) == Some("image/svg+xml"))
    })
}

pub(crate) fn read_drawing(
    archive: &mut ZipArchive<File>,
    drawing_path: &str,
    sheet_id: &str,
    id_offset: usize,
    colors: &ColorContext,
    ole_shape_ids: &HashSet<u32>,
    slicer_captions: &HashMap<String, String>,
    formats: &mut SourceFormats,
) -> Result<Vec<VisualObject>, SidecarError> {
    let xml = read_xml(archive, drawing_path)?;
    let document = parse_document(&xml, drawing_path)?;
    let mut relationships = read_relationships(archive, drawing_path)?;
    relationships.retain(|_, relationship| {
        !is_image_relationship(relationship)
            || drawing_image_path(drawing_path, relationship)
                .is_some_and(|path| crate::zip_entry(archive, &path).is_ok())
    });
    let mut visuals = Vec::new();
    for (index, anchor_node) in document
        .descendants()
        .filter(|node| {
            node.has_tag_name("twoCellAnchor")
                || node.has_tag_name("oneCellAnchor")
                || node.has_tag_name("absoluteAnchor")
        })
        .enumerate()
    {
        let Some(anchor) = parse_anchor(anchor_node) else {
            continue;
        };
        // Excel does not render objects flagged hidden (cNvPr hidden="1").
        // OLE compat fallback shapes are the exception: they are kept so the
        // caller can put the OLE visual in their z-order slot (borrowing the
        // anchor when the object has none), then dropped.
        let nv = anchor_node
            .descendants()
            .find(|node| node.has_tag_name("cNvPr"));
        let hidden = nv.is_some_and(hidden_attribute);
        let is_ole_placeholder = nv
            .and_then(|node| node.attribute("id"))
            .and_then(|value| value.parse::<u32>().ok())
            .is_some_and(|id| ole_shape_ids.contains(&id));
        if hidden && !is_ole_placeholder {
            continue;
        }
        let visual_id = format!("visual-{}", id_offset + index + 1);
        if let Some(group) = anchor_node
            .children()
            .find(|node| node.has_tag_name("grpSp"))
        {
            // The group box spans the whole anchor; its EMU size comes from
            // the group's own xfrm ext (Excel keeps the two equal).
            let xfrm = group_xfrm(group);
            let width = xfrm_value(xfrm, "ext", "cx").unwrap_or(0.0);
            let height = xfrm_value(xfrm, "ext", "cy").unwrap_or(0.0);
            if width > 0.0 && height > 0.0 {
                let mut counter = 0;
                expand_group(
                    group,
                    &anchor,
                    (0.0, 0.0, width, height),
                    &visual_id,
                    &mut counter,
                    sheet_id,
                    colors,
                    drawing_path,
                    &relationships,
                    &mut visuals,
                    0,
                    GroupMapping::default(),
                )?;
            }
            continue;
        }
        if let Some(chart_node) = anchor_node
            .descendants()
            .find(|node| node.has_tag_name("chart"))
        {
            let Some(id) = relationship_id(chart_node) else {
                continue;
            };
            let Some(relationship) = relationships.get(&id) else {
                continue;
            };
            let chart_path = resolve_part_target(drawing_path, &relationship.target)?;
            visuals.push(VisualObject {
                id: visual_id,
                sheet_id: sheet_id.to_owned(),
                kind: "chart".into(),
                anchor,
                chart: Some(read_chart(archive, &chart_path, colors, formats)?),
                chart_path: Some(chart_path.clone()),
                media_path: None,
                media_type: None,
                opacity: None,
                crop: None,
                fill_media_path: None,
                fill_media_type: None,
                name: drawing_name(anchor_node),
                shape_type: None,
                custom_path: None,
                fill_color: None,
                fill_gradient: None,
                line_color: None,
                line_width: None,
                line_dash: None,
                line_cap: None,
                flip_h: false,
                flip_v: false,
                text_color: None,
                text_anchor: None,
                text_vert_overflow: None,
                text_horz_overflow: None,
                paragraphs: None,
                text: None,
                prog_id: None,
                rotation: None,
                frame_width: None,
                frame_height: None,
                group_transform: None,
                nv_id: None,
                drawing_path: Some(drawing_path.to_owned()),
                drawing_index: Some(index),
                alt_text: None,
                edit_as: None,
                hyperlink: None,
            });
            continue;
        }
        // Only an xdr:pic is a picture — an xdr:sp with a:blipFill keeps its
        // geometry and outline and falls through to the shape branch.
        if let Some(pic_node) = anchor_node
            .descendants()
            .find(|node| node.has_tag_name("pic"))
        {
            let Some(blip_node) = picture_blip(pic_node) else {
                continue;
            };
            // Excel draws nothing for a picture whose anchor collapses to a
            // point (from == to with equal offsets, or a 0x0 ext).
            if anchor_is_zero_extent(&anchor) {
                continue;
            }
            let Some(media_path) = blip_media_path(blip_node, drawing_path, &relationships) else {
                continue;
            };
            visuals.push(VisualObject {
                id: visual_id,
                sheet_id: sheet_id.to_owned(),
                kind: "image".into(),
                anchor,
                chart: None,
                chart_path: None,
                media_type: media_type_for_path(&media_path).map(ToOwned::to_owned),
                media_path: Some(media_path),
                opacity: blip_opacity(blip_node),
                crop: blip_crop(pic_node),
                fill_media_path: None,
                fill_media_type: None,
                name: drawing_name(anchor_node),
                shape_type: None,
                custom_path: None,
                fill_color: None,
                fill_gradient: None,
                line_color: None,
                line_width: None,
                line_dash: None,
                line_cap: None,
                flip_h: false,
                flip_v: false,
                text_color: None,
                text_anchor: None,
                text_vert_overflow: None,
                text_horz_overflow: None,
                paragraphs: None,
                text: None,
                prog_id: None,
                rotation: None,
                frame_width: None,
                frame_height: None,
                group_transform: None,
                nv_id: None,
                drawing_path: Some(drawing_path.to_owned()),
                drawing_index: Some(index),
                alt_text: None,
                edit_as: None,
                hyperlink: None,
            });
            continue;
        }
        // Slicer/timeline graphicFrames come wrapped in mc:AlternateContent
        // whose mc:Fallback is a text box ("This shape represents a
        // slicer..."). Excel renders the Choice, so the fallback must never
        // surface; a read-only placeholder keeps the footprint instead.
        if let Some(slicer_name) = slicer_frame_name(anchor_node) {
            visuals.push(VisualObject {
                id: visual_id,
                sheet_id: sheet_id.to_owned(),
                kind: "slicer".into(),
                anchor,
                chart: None,
                chart_path: None,
                media_path: None,
                media_type: None,
                opacity: None,
                crop: None,
                fill_media_path: None,
                fill_media_type: None,
                name: Some(slicer_name.to_owned()),
                shape_type: None,
                custom_path: None,
                fill_color: None,
                fill_gradient: None,
                line_color: None,
                line_width: None,
                line_dash: None,
                line_cap: None,
                flip_h: false,
                flip_v: false,
                text_color: None,
                text_anchor: None,
                text_vert_overflow: None,
                text_horz_overflow: None,
                paragraphs: None,
                text: Some(
                    slicer_captions
                        .get(slicer_name)
                        .cloned()
                        .unwrap_or_else(|| slicer_name.to_owned()),
                ),
                prog_id: None,
                rotation: None,
                frame_width: None,
                frame_height: None,
                group_transform: None,
                nv_id: None,
                drawing_path: None,
                drawing_index: None,
                alt_text: None,
                edit_as: None,
                hyperlink: None,
            });
            continue;
        }
        if let Some(shape_node) = anchor_node
            .descendants()
            .find(|node| node.has_tag_name("sp") || node.has_tag_name("cxnSp"))
        {
            let mut shape = shape_visual(
                shape_node,
                anchor,
                visual_id,
                sheet_id,
                drawing_name(anchor_node),
                colors,
                drawing_path,
                &relationships,
                Some(index),
            );
            // nv_id pairs only the hidden OLE compat fallback with its
            // <oleObject>; a visible shape that happens to share a cNvPr id
            // with an OLE shapeId must stay a regular shape.
            if !(hidden && is_ole_placeholder) {
                shape.nv_id = None;
            }
            visuals.push(shape);
        }
    }
    let anchors: Vec<Node<'_, '_>> = document
        .descendants()
        .filter(|node| {
            node.has_tag_name("twoCellAnchor")
                || node.has_tag_name("oneCellAnchor")
                || node.has_tag_name("absoluteAnchor")
        })
        .collect();
    for visual in &mut visuals {
        if let Some(anchor_node) = visual.drawing_index.and_then(|index| anchors.get(index)) {
            apply_anchor_properties(visual, *anchor_node, &relationships);
        }
    }
    // Chart children of expanded groups carry only their part path.
    for visual in &mut visuals {
        if visual.kind == "chart" && visual.chart.is_none() {
            if let Some(chart_path) = visual.chart_path.clone() {
                visual.chart = Some(read_chart(archive, &chart_path, colors, formats)?);
            }
        }
    }
    Ok(visuals)
}

/// Anchor-level properties shared by every object kind: editAs, alt text,
/// hyperlink — and for pictures the xfrm rotation/flip the shape branch
/// already reads for itself.
pub(crate) fn apply_anchor_properties(
    visual: &mut VisualObject,
    anchor_node: Node<'_, '_>,
    relationships: &HashMap<String, Relationship>,
) {
    if anchor_node.has_tag_name("twoCellAnchor") {
        visual.edit_as = Some(
            anchor_node
                .attribute("editAs")
                .unwrap_or("twoCell")
                .to_owned(),
        );
    }
    let nv = anchor_node
        .descendants()
        .find(|node| node.has_tag_name("cNvPr"));
    visual.alt_text = nv
        .and_then(|node| node.attribute("descr"))
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned);
    visual.hyperlink = nv
        .and_then(|node| {
            node.children()
                .find(|child| child.has_tag_name("hlinkClick"))
        })
        .and_then(relationship_id)
        .and_then(|id| relationships.get(&id))
        .map(|relationship| relationship.target.clone());
    if visual.kind != "image" {
        return;
    }
    let xfrm = anchor_node
        .descendants()
        .find(|node| node.has_tag_name("xfrm"));
    let flipped = |attribute: &str| {
        xfrm.and_then(|node| node.attribute(attribute))
            .is_some_and(|value| value == "1" || value == "true")
    };
    visual.flip_h = flipped("flipH");
    visual.flip_v = flipped("flipV");
    visual.rotation = xfrm
        .and_then(|node| node.attribute("rot"))
        .and_then(|value| value.parse::<f64>().ok())
        .map(|value| value / 60_000.0)
        .filter(|value| *value != 0.0);
    if visual.rotation.is_some() {
        visual.frame_width = xfrm_value(xfrm, "ext", "cx").filter(|value| *value > 0.0);
        visual.frame_height = xfrm_value(xfrm, "ext", "cy").filter(|value| *value > 0.0);
    }
}

/// `sle:slicer` / `tsle:timeslicer` @name of a slicer graphicFrame anchor.
fn slicer_frame_name<'a>(anchor_node: Node<'a, '_>) -> Option<&'a str> {
    anchor_node
        .descendants()
        .find(|node| {
            node.has_tag_name("graphicData")
                && node
                    .attribute("uri")
                    .is_some_and(|uri| uri.ends_with("/slicer") || uri.ends_with("/timeslicer"))
        })
        .and_then(|data| data.first_element_child())
        .and_then(|node| node.attribute("name"))
}

/// One `sp`/`cxnSp` node → a shape visual placed at `anchor`. Shared by the
/// direct anchor branch and grpSp expansion (children pass their own name
/// and no drawing_index — anchor edits would rewrite the whole group).
#[allow(clippy::too_many_arguments)]
pub(crate) fn shape_visual(
    shape_node: Node<'_, '_>,
    anchor: DrawingAnchor,
    visual_id: String,
    sheet_id: &str,
    name: Option<String>,
    colors: &ColorContext,
    drawing_path: &str,
    relationships: &HashMap<String, Relationship>,
    drawing_index: Option<usize>,
) -> VisualObject {
    {
        {
            let shape_type = shape_node
                .descendants()
                .find(|node| node.has_tag_name("prstGeom"))
                .and_then(|node| node.attribute("prst"))
                .map(ToOwned::to_owned);
            let custom_path = if shape_type.is_none() {
                parse_custom_geometry(shape_node)
            } else {
                None
            };
            let shape_sppr = shape_node.children().find(|node| node.has_tag_name("spPr"));
            // An explicit <a:noFill/> directly under spPr means transparent —
            // it must not fall through to the xdr:style fillRef theme color.
            let has_no_fill = shape_sppr
                .is_some_and(|sppr| sppr.children().any(|node| node.has_tag_name("noFill")));
            let fill_color = if has_no_fill {
                Some("none".into())
            } else {
                shape_sppr.and_then(|sppr| area_fill_color(sppr, colors))
            };
            let fill_blip = shape_sppr
                .and_then(|sppr| drawing_main_children(sppr, "blipFill").next())
                .and_then(|fill| drawing_main_children(fill, "blip").next());
            let fill_media_path = fill_blip
                .and_then(|blip| blip_media_path(blip, drawing_path, relationships));
            let fill_media_opacity = fill_media_path
                .as_ref()
                .and(fill_blip)
                .and_then(blip_opacity);
            let fill_media_type = fill_media_path
                .as_deref()
                .and_then(media_type_for_path)
                .map(ToOwned::to_owned);
            let xfrm = shape_node
                .descendants()
                .find(|node| node.has_tag_name("xfrm"));
            let rotation = xfrm
                .and_then(|node| node.attribute("rot"))
                .and_then(|value| value.parse::<f64>().ok())
                .map(|value| value / 60_000.0);
            // Only rotated shapes need the true frame — unrotated anchors
            // already are the frame.
            let frame_extent = |attribute: &str| {
                if rotation.is_none() {
                    return None;
                }
                xfrm_value(xfrm, "ext", attribute).filter(|value| *value > 0.0)
            };
            let frame_width = frame_extent("cx");
            let frame_height = frame_extent("cy");
            let flipped = |attribute: &str| {
                xfrm.and_then(|node| node.attribute(attribute))
                    .is_some_and(|value| value == "1" || value == "true")
            };
            let body = shape_node
                .descendants()
                .find(|node| node.has_tag_name("txBody"));
            let paragraphs = body
                .map(|node| parse_text_paragraphs(node, colors))
                .filter(|list| !list.is_empty());
            let text = paragraphs.as_ref().map(|list| {
                list.iter()
                    .map(|paragraph| {
                        paragraph
                            .runs
                            .iter()
                            .map(|run| run.text.as_str())
                            .collect::<String>()
                    })
                    .collect::<Vec<_>>()
                    .join("\n")
            });
            let body_pr = body.and_then(|node| direct_child(node, "bodyPr"));
            let body_attribute = |name: &str| {
                body_pr
                    .and_then(|node| node.attribute(name))
                    .map(ToOwned::to_owned)
            };
            let text_anchor = body_attribute("anchor");
            let text_vert_overflow = body_attribute("vertOverflow");
            let text_horz_overflow = body_attribute("horzOverflow");
            // xdr:style theme references are the fallback when spPr carries
            // no explicit fill/line (Excel's default for inserted shapes).
            let style_node = shape_node
                .children()
                .find(|node| node.has_tag_name("style"));
            // idx 0 / 1000 reference the "no fill" slot (ECMA-376 20.1.4.2.10
            // / 20.1.4.2.19); the schemeClr child is only a placeholder.
            let style_color = |name: &str| {
                let reference = style_node?
                    .children()
                    .find(|node| node.has_tag_name(name))?;
                if matches!(reference.attribute("idx"), Some("0" | "1000")) {
                    return Some("none".into());
                }
                let scheme = reference
                    .children()
                    .find(|node| node.has_tag_name("schemeClr"))?;
                let base = scheme_color_rgb(scheme.attribute("val")?, colors)?;
                Some(apply_color_modifiers(scheme, base))
            };
            let fill_gradient = if fill_color.is_none() && fill_media_path.is_none() {
                style_fill_gradient(style_node, colors)
            } else {
                None
            };
            // An explicit spPr blipFill replaces the style fillRef entirely:
            // the frame stays transparent while the image loads.
            // No spPr fill, no blip and no style reference is DrawingML's
            // "no fill": Excel draws the shape transparent.
            let fill_color = fill_color
                .or_else(|| {
                    if fill_media_path.is_some() {
                        Some("none".into())
                    } else {
                        style_color("fillRef")
                    }
                })
                .or_else(|| fill_gradient.is_none().then(|| "none".into()));
            let line_node = shape_node
                .children()
                .find(|node| node.has_tag_name("spPr"))
                .and_then(|sppr| sppr.children().find(|node| node.has_tag_name("ln")));
            let line_color = line_node
                .and_then(|ln| {
                    if ln.children().any(|node| node.has_tag_name("noFill")) {
                        return Some("none".into());
                    }
                    drawing_fill_color(ln, colors)
                })
                .or_else(|| style_color("lnRef"))
                .or_else(|| Some("none".into()));
            let line_width = line_node
                .and_then(|ln| ln.attribute("w"))
                .and_then(|value| value.parse::<f64>().ok())
                .map(|emu| emu / 12_700.0);
            let line_dash = line_node
                .and_then(|ln| ln.children().find(|node| node.has_tag_name("prstDash")))
                .and_then(|node| node.attribute("val"))
                .map(ToOwned::to_owned);
            let line_cap = line_node
                .and_then(|ln| ln.attribute("cap"))
                .map(ToOwned::to_owned);
            let text_color = style_color("fontRef");
            let nv_id = shape_node
                .descendants()
                .find(|node| node.has_tag_name("cNvPr"))
                .and_then(|node| node.attribute("id"))
                .and_then(|value| value.parse::<u32>().ok());
            VisualObject {
                id: visual_id,
                sheet_id: sheet_id.to_owned(),
                kind: "shape".into(),
                anchor,
                chart: None,
                chart_path: None,
                media_path: None,
                media_type: None,
                opacity: fill_media_opacity,
                crop: None,
                fill_media_path,
                fill_media_type,
                name,
                shape_type,
                custom_path,
                fill_color,
                fill_gradient,
                line_color,
                line_width,
                line_dash,
                line_cap,
                flip_h: flipped("flipH"),
                flip_v: flipped("flipV"),
                text_color,
                text_anchor,
                text_vert_overflow,
                text_horz_overflow,
                paragraphs,
                text,
                prog_id: None,
                rotation,
                frame_width,
                frame_height,
                group_transform: None,
                nv_id,
                drawing_path: Some(drawing_path.to_owned()),
                drawing_index,
                alt_text: None,
                edit_as: None,
                hyperlink: None,
            }
        }
    }
}

pub(crate) fn format_path_number(value: f64) -> String {
    if value.fract() == 0.0 && value.abs() < 1e15 {
        format!("{}", value as i64)
    } else {
        format!("{value:.2}")
    }
}

/// Parse a shape's a:custGeom pathLst into one SVG path string. Multiple
/// `<a:path>` entries scale into the first path's coordinate space. Returns
/// None when a command has no SVG mapping (arcTo) — the caller falls back
/// to the placeholder frame.
pub(crate) fn parse_custom_geometry(shape_node: Node<'_, '_>) -> Option<CustomPath> {
    let geometry = shape_node
        .descendants()
        .find(|node| node.has_tag_name("custGeom"))?;
    let path_list = geometry
        .children()
        .find(|node| node.has_tag_name("pathLst"))?;
    let mut base_width = 0.0_f64;
    let mut base_height = 0.0_f64;
    let mut d = String::new();
    let mut fill_d = String::new();
    let mut stroke_only = true;
    for path in path_list
        .children()
        .filter(|node| node.has_tag_name("path"))
    {
        let dimension = |attribute: &str| {
            path.attribute(attribute)
                .and_then(|value| value.parse::<f64>().ok())
                .filter(|value| *value > 0.0)
                .unwrap_or(0.0)
        };
        let width = dimension("w");
        let height = dimension("h");
        if d.is_empty() {
            base_width = width;
            base_height = height;
        }
        let path_fills = path.attribute("fill") != Some("none");
        if path_fills {
            stroke_only = false;
        }
        let segment_start = d.len();
        let scale_x = if width > 0.0 && base_width > 0.0 {
            base_width / width
        } else {
            1.0
        };
        let scale_y = if height > 0.0 && base_height > 0.0 {
            base_height / height
        } else {
            1.0
        };
        for command in path.children().filter(|node| node.is_element()) {
            let points: Vec<(f64, f64)> = command
                .children()
                .filter(|node| node.has_tag_name("pt"))
                .filter_map(|point| {
                    Some((
                        point.attribute("x")?.parse::<f64>().ok()? * scale_x,
                        point.attribute("y")?.parse::<f64>().ok()? * scale_y,
                    ))
                })
                .collect();
            let (letter, expected) = match command.tag_name().name() {
                "moveTo" => ("M", 1),
                "lnTo" => ("L", 1),
                "cubicBezTo" => ("C", 3),
                "quadBezTo" => ("Q", 2),
                "close" => ("Z", 0),
                _ => return None,
            };
            if points.len() < expected {
                return None;
            }
            if !d.is_empty() {
                d.push(' ');
            }
            d.push_str(letter);
            for (x, y) in points.iter().take(expected) {
                d.push(' ');
                d.push_str(&format_path_number(*x));
                d.push(' ');
                d.push_str(&format_path_number(*y));
            }
        }
        if path_fills && d.len() > segment_start {
            if !fill_d.is_empty() {
                fill_d.push(' ');
            }
            fill_d.push_str(d[segment_start..].trim_start());
        }
    }
    if d.is_empty() {
        return None;
    }
    let fill_d = if stroke_only || fill_d == d {
        None
    } else {
        Some(fill_d)
    };
    Some(CustomPath {
        width: base_width.max(1.0),
        height: base_height.max(1.0),
        d,
        stroke_only,
        fill_d,
    })
}

pub(crate) fn hidden_attribute(node: Node<'_, '_>) -> bool {
    node.attribute("hidden")
        .is_some_and(|value| value == "1" || value == "true")
}

pub(crate) fn group_xfrm<'a>(group: Node<'a, 'a>) -> Option<Node<'a, 'a>> {
    group
        .children()
        .find(|node| node.has_tag_name("grpSpPr"))?
        .children()
        .find(|node| node.has_tag_name("xfrm"))
}

pub(crate) fn xfrm_value(xfrm: Option<Node<'_, '_>>, tag: &str, attribute: &str) -> Option<f64> {
    xfrm?
        .children()
        .find(|node| node.has_tag_name(tag))?
        .attribute(attribute)?
        .parse::<f64>()
        .ok()
}

fn xfrm_flipped(xfrm: Option<Node<'_, '_>>, attribute: &str) -> bool {
    xfrm.and_then(|node| node.attribute(attribute))
        .is_some_and(|value| value == "1" || value == "true")
}

type DrawingMatrix = [f64; 4];

#[derive(Clone, Copy)]
pub(crate) struct GroupMapping {
    matrix: DrawingMatrix,
    x: f64,
    y: f64,
    rotated: bool,
}

impl Default for GroupMapping {
    fn default() -> Self {
        Self {
            matrix: [1.0, 0.0, 0.0, 1.0],
            x: 0.0,
            y: 0.0,
            rotated: false,
        }
    }
}

impl GroupMapping {
    fn point(self, x: f64, y: f64) -> (f64, f64) {
        let [a, b, c, d] = self.matrix;
        (self.x + a * x + c * y, self.y + b * x + d * y)
    }
}

fn xfrm_radians(xfrm: Option<Node<'_, '_>>) -> f64 {
    xfrm.and_then(|node| node.attribute("rot"))
        .and_then(|value| value.parse::<i32>().ok())
        .map_or(0.0, |angle| {
            f64::from(angle % 21_600_000) * std::f64::consts::PI / 10_800_000.0
        })
}

fn drawing_orientation(xfrm: Option<Node<'_, '_>>, radians: f64) -> DrawingMatrix {
    let (sin, cos) = radians.sin_cos();
    let clean = |value: f64| if value.abs() < 1e-12 { 0.0 } else { value };
    let flip_x = if xfrm_flipped(xfrm, "flipH") { -1.0 } else { 1.0 };
    let flip_y = if xfrm_flipped(xfrm, "flipV") { -1.0 } else { 1.0 };
    [
        clean(cos * flip_x),
        clean(sin * flip_x),
        clean(-sin * flip_y),
        clean(cos * flip_y),
    ]
}

fn multiply_drawing_matrices([a, b, c, d]: DrawingMatrix, [e, f, g, h]: DrawingMatrix) -> DrawingMatrix {
    [a * e + c * f, b * e + d * f, a * g + c * h, b * g + d * h]
}

fn apply_group_transform(
    visual: &mut VisualObject,
    flip_h: bool,
    flip_v: bool,
    width: f64,
    height: f64,
    transform: Option<GroupChildTransform>,
) {
    if let Some(transform) = transform {
        visual.group_transform = Some(transform);
        visual.flip_h = false;
        visual.flip_v = false;
        visual.rotation = None;
        visual.frame_width = None;
        visual.frame_height = None;
        return;
    }
    visual.flip_h ^= flip_h;
    visual.flip_v ^= flip_v;
    if let Some(rotation) = &mut visual.rotation {
        // A single reflection reverses the handedness of a child's rotation.
        if flip_h != flip_v {
            *rotation = -*rotation;
        }
        visual.frame_width = (width > 0.0).then_some(width);
        visual.frame_height = (height > 0.0).then_some(height);
    }
}

/// Flatten a grpSp into per-child visuals. `group_box` is the group's frame
/// as (x, y, width, height) in the parent group's child coordinate space.
/// The outermost frame is relative to the anchor's `from` marker.
#[allow(clippy::too_many_arguments)]
pub(crate) fn expand_group(
    group: Node<'_, '_>,
    anchor: &DrawingAnchor,
    group_box: (f64, f64, f64, f64),
    visual_id: &str,
    counter: &mut usize,
    sheet_id: &str,
    colors: &ColorContext,
    drawing_path: &str,
    relationships: &HashMap<String, Relationship>,
    visuals: &mut Vec<VisualObject>,
    depth: usize,
    parent: GroupMapping,
) -> Result<(), SidecarError> {
    // A stack overflow is not a panic — catch_unwind cannot stop the process
    // abort, and the file itself decides how deep this recursion goes. Excel
    // nests groups a handful of levels deep; anything past MAX_GROUP_DEPTH is
    // skipped, not followed.
    const MAX_GROUP_DEPTH: usize = 32;
    if depth > MAX_GROUP_DEPTH {
        return Ok(());
    }
    let (box_x, box_y, box_width, box_height) = group_box;
    let xfrm = group_xfrm(group);
    let radians = xfrm_radians(xfrm);
    let rotated = parent.rotated || radians != 0.0;
    let ch_off_x = xfrm_value(xfrm, "chOff", "x").unwrap_or(0.0);
    let ch_off_y = xfrm_value(xfrm, "chOff", "y").unwrap_or(0.0);
    let ch_ext_x = xfrm_value(xfrm, "chExt", "cx")
        .filter(|value| value.is_finite() && *value > 0.0)
        .unwrap_or(box_width);
    let ch_ext_y = xfrm_value(xfrm, "chExt", "cy")
        .filter(|value| value.is_finite() && *value > 0.0)
        .unwrap_or(box_height);
    let scale_x = box_width / ch_ext_x;
    let scale_y = box_height / ch_ext_y;
    let [a, b, c, d] = drawing_orientation(xfrm, radians);
    let matrix = multiply_drawing_matrices(
        parent.matrix,
        [a * scale_x, b * scale_x, c * scale_y, d * scale_y],
    );
    let (center_x, center_y) = parent.point(box_x + box_width / 2.0, box_y + box_height / 2.0);
    let source_x = ch_off_x + ch_ext_x / 2.0;
    let source_y = ch_off_y + ch_ext_y / 2.0;
    let world = GroupMapping {
        matrix,
        x: center_x - matrix[0] * source_x - matrix[2] * source_y,
        y: center_y - matrix[1] * source_x - matrix[3] * source_y,
        rotated,
    };
    let flip_h = matrix[0] < 0.0;
    let flip_v = matrix[3] < 0.0;
    for child in group.children() {
        let is_group = child.has_tag_name("grpSp");
        let is_shape = child.has_tag_name("sp") || child.has_tag_name("cxnSp");
        let is_picture = child.has_tag_name("pic");
        let is_frame = child.has_tag_name("graphicFrame");
        if !is_group && !is_shape && !is_picture && !is_frame {
            continue;
        }
        if child
            .descendants()
            .find(|node| node.has_tag_name("cNvPr"))
            .is_some_and(hidden_attribute)
        {
            continue;
        }
        // The first xfrm under the child is its own (spPr or grpSpPr).
        let child_xfrm = child.descendants().find(|node| node.has_tag_name("xfrm"));
        let (Some(off_x), Some(off_y), Some(ext_x), Some(ext_y)) = (
            xfrm_value(child_xfrm, "off", "x"),
            xfrm_value(child_xfrm, "off", "y"),
            xfrm_value(child_xfrm, "ext", "cx"),
            xfrm_value(child_xfrm, "ext", "cy"),
        ) else {
            continue;
        };
        if ![off_x, off_y, ext_x, ext_y].into_iter().all(f64::is_finite)
            || ext_x < 0.0
            || ext_y < 0.0
        {
            continue;
        }
        if is_group {
            if ext_x > 0.0 && ext_y > 0.0 {
                expand_group(
                    child,
                    anchor,
                    (off_x, off_y, ext_x, ext_y),
                    visual_id,
                    counter,
                    sheet_id,
                    colors,
                    drawing_path,
                    relationships,
                    visuals,
                    depth + 1,
                    world,
                )?;
            }
            continue;
        }
        let child_matrix = if rotated {
            multiply_drawing_matrices(
                matrix,
                drawing_orientation(child_xfrm, xfrm_radians(child_xfrm)),
            )
        } else {
            matrix
        };
        let (center_x, center_y) = world.point(off_x + ext_x / 2.0, off_y + ext_y / 2.0);
        let width = child_matrix[0].abs() * ext_x + child_matrix[2].abs() * ext_y;
        let height = child_matrix[1].abs() * ext_x + child_matrix[3].abs() * ext_y;
        if ![center_x, center_y, width, height]
            .into_iter()
            .all(f64::is_finite)
        {
            continue;
        }
        let transform = rotated.then_some(GroupChildTransform {
            matrix: child_matrix,
            width: ext_x,
            height: ext_y,
        });
        let child_anchor = DrawingAnchor {
            from_row: anchor.from_row,
            from_column: anchor.from_column,
            from_row_offset: anchor
                .from_row_offset
                .saturating_add((center_y - height / 2.0).round() as i64),
            from_column_offset: anchor
                .from_column_offset
                .saturating_add((center_x - width / 2.0).round() as i64),
            to_row: anchor.from_row,
            to_column: anchor.from_column,
            to_row_offset: anchor
                .from_row_offset
                .saturating_add((center_y + height / 2.0).round() as i64),
            to_column_offset: anchor
                .from_column_offset
                .saturating_add((center_x + width / 2.0).round() as i64),
            explicit_to: false,
            absolute: false,
        };
        *counter += 1;
        let child_id = format!("{visual_id}-{counter}");
        let child_name = child
            .descendants()
            .find(|node| node.has_tag_name("cNvPr"))
            .and_then(|node| node.attribute("name"))
            .map(ToOwned::to_owned);
        if is_shape {
            let mut shape = shape_visual(
                child,
                child_anchor,
                child_id,
                sheet_id,
                child_name,
                colors,
                drawing_path,
                relationships,
                None,
            );
            apply_anchor_properties(&mut shape, child, relationships);
            apply_group_transform(&mut shape, flip_h, flip_v, width, height, transform);
            visuals.push(shape);
            continue;
        }
        if is_frame {
            // Chart data is backfilled by read_drawing (reading the part
            // needs the archive, which this expansion deliberately avoids).
            let Some(chart_path) = child
                .descendants()
                .find(|node| node.has_tag_name("chart"))
                .and_then(relationship_id)
                .and_then(|id| relationships.get(&id))
                .map(|relationship| resolve_part_target(drawing_path, &relationship.target))
                .transpose()?
            else {
                continue;
            };
            let mut chart = VisualObject {
                id: child_id,
                sheet_id: sheet_id.to_owned(),
                kind: "chart".into(),
                anchor: child_anchor,
                chart: None,
                chart_path: Some(chart_path),
                media_path: None,
                media_type: None,
                opacity: None,
                crop: None,
                fill_media_path: None,
                fill_media_type: None,
                name: child_name,
                shape_type: None,
                custom_path: None,
                fill_color: None,
                fill_gradient: None,
                line_color: None,
                line_width: None,
                line_dash: None,
                line_cap: None,
                flip_h: xfrm_flipped(child_xfrm, "flipH"),
                flip_v: xfrm_flipped(child_xfrm, "flipV"),
                text_color: None,
                text_anchor: None,
                text_vert_overflow: None,
                text_horz_overflow: None,
                paragraphs: None,
                text: None,
                prog_id: None,
                rotation: None,
                frame_width: None,
                frame_height: None,
                group_transform: None,
                nv_id: None,
                drawing_path: Some(drawing_path.to_owned()),
                drawing_index: None,
                alt_text: None,
                edit_as: None,
                hyperlink: None,
            };
            apply_group_transform(&mut chart, flip_h, flip_v, width, height, transform);
            visuals.push(chart);
            continue;
        }
        let Some(blip_node) = picture_blip(child) else {
            continue;
        };
        if anchor_is_zero_extent(&child_anchor) {
            continue;
        }
        let Some(media_path) = blip_media_path(blip_node, drawing_path, relationships) else {
            continue;
        };
        let mut picture = VisualObject {
            id: child_id,
            sheet_id: sheet_id.to_owned(),
            kind: "image".into(),
            anchor: child_anchor,
            chart: None,
            chart_path: None,
            media_type: media_type_for_path(&media_path).map(ToOwned::to_owned),
            media_path: Some(media_path),
            opacity: blip_opacity(blip_node),
            crop: blip_crop(child),
            fill_media_path: None,
            fill_media_type: None,
            name: child_name,
            shape_type: None,
            custom_path: None,
            fill_color: None,
            fill_gradient: None,
            line_color: None,
            line_width: None,
            line_dash: None,
            line_cap: None,
            flip_h: false,
            flip_v: false,
            text_color: None,
            text_anchor: None,
            text_vert_overflow: None,
            text_horz_overflow: None,
            paragraphs: None,
            text: None,
            prog_id: None,
            rotation: None,
            frame_width: None,
            frame_height: None,
            group_transform: None,
            nv_id: None,
            drawing_path: Some(drawing_path.to_owned()),
            drawing_index: None,
            alt_text: None,
            edit_as: None,
            hyperlink: None,
        };
        // Group children have no anchor of their own: the pic element is the
        // scope, and its xfrm ext is in child space, so the frame rescales.
        apply_anchor_properties(&mut picture, child, relationships);
        apply_group_transform(&mut picture, flip_h, flip_v, width, height, transform);
        visuals.push(picture);
    }
    Ok(())
}

/// Both markers coincide — a zero span on both axes. (The no-ext fallbacks
/// in parse_anchor always produce a real span, so they never match.)
pub(crate) fn anchor_is_zero_extent(anchor: &DrawingAnchor) -> bool {
    anchor.from_row == anchor.to_row
        && anchor.from_row_offset == anchor.to_row_offset
        && anchor.from_column == anchor.to_column
        && anchor.from_column_offset == anchor.to_column_offset
}

/// a:blip/a:alphaModFix amt (per-100000) → 0..1; None when absent or opaque.
pub(crate) fn blip_opacity(blip_node: Node<'_, '_>) -> Option<f64> {
    let amt = blip_node
        .children()
        .find(|node| node.has_tag_name("alphaModFix"))?
        .attribute("amt")?
        .parse::<f64>()
        .ok()?;
    let opacity = (amt / 100_000.0).clamp(0.0, 1.0);
    (opacity < 1.0).then_some(opacity)
}

/// a:srcRect l/t/r/b (per-100000 of the source size) under `scope` → 0..1
/// crop fractions; None when absent, all-zero, or nothing would remain.
pub(crate) fn blip_crop(scope: Node<'_, '_>) -> Option<CropRect> {
    let rect = scope
        .descendants()
        .find(|node| node.has_tag_name("srcRect"))?;
    let side = |name: &str| {
        rect.attribute(name)
            .and_then(|value| value.parse::<f64>().ok())
            .map(|value| value / 100_000.0)
            .unwrap_or(0.0)
    };
    let sides = [side("l"), side("t"), side("r"), side("b")];
    if sides
        .iter()
        .any(|value| !value.is_finite() || value.abs() > 1.0)
        || sides.iter().all(|value| *value == 0.0)
        || sides[0] + sides[2] >= 1.0
        || sides[1] + sides[3] >= 1.0
    {
        return None;
    }
    Some(CropRect {
        left: sides[0],
        top: sides[1],
        right: sides[2],
        bottom: sides[3],
    })
}

pub(crate) fn parse_anchor(anchor: Node<'_, '_>) -> Option<DrawingAnchor> {
    let Some(from) = direct_child(anchor, "from") else {
        // absoluteAnchor: xdr:pos + xdr:ext in sheet EMU. Encode both corners
        // as offsets from cell (0,0) — the renderer's marker walk carries
        // offsets across real row/column sizes.
        let pos = direct_child(anchor, "pos")?;
        let ext = direct_child(anchor, "ext")?;
        let coordinate =
            |node: Node<'_, '_>, attribute: &str| node.attribute(attribute)?.parse::<i64>().ok();
        let x = coordinate(pos, "x")?;
        let y = coordinate(pos, "y")?;
        let cx = coordinate(ext, "cx")?;
        let cy = coordinate(ext, "cy")?;
        return Some(DrawingAnchor {
            from_row: 0,
            from_column: 0,
            from_row_offset: y,
            from_column_offset: x,
            to_row: 0,
            to_column: 0,
            to_row_offset: y + cy,
            to_column_offset: x + cx,
            explicit_to: false,
            absolute: true,
        });
    };
    let from_row = marker_value(from, "row")?;
    let from_column = marker_value(from, "col")?;
    let from_row_offset = marker_signed_value(from, "rowOff").unwrap_or(0);
    let from_column_offset = marker_signed_value(from, "colOff").unwrap_or(0);
    if let Some(to) = direct_child(anchor, "to") {
        return Some(DrawingAnchor {
            from_row,
            from_column,
            from_row_offset,
            from_column_offset,
            to_row: marker_value(to, "row").unwrap_or(from_row + 20),
            to_column: marker_value(to, "col").unwrap_or(from_column + 8),
            to_row_offset: marker_signed_value(to, "rowOff").unwrap_or(0),
            to_column_offset: marker_signed_value(to, "colOff").unwrap_or(0),
            explicit_to: true,
            absolute: false,
        });
    }
    // oneCellAnchor: the size lives in xdr:ext (EMU). Encode it as offsets
    // within the from cell — the renderer's marker walk handles offsets past
    // the cell edge, so no new anchor fields are needed. (Previously `to`
    // fell back to `from` itself: a zero-size box.)
    let ext = direct_child(anchor, "ext");
    let extent = |attribute: &str| {
        ext.and_then(|node| node.attribute(attribute))
            .and_then(|value| value.parse::<i64>().ok())
    };
    match (extent("cx"), extent("cy")) {
        (Some(cx), Some(cy)) => Some(DrawingAnchor {
            from_row,
            from_column,
            from_row_offset,
            from_column_offset,
            to_row: from_row,
            to_column: from_column,
            to_row_offset: from_row_offset + cy,
            to_column_offset: from_column_offset + cx,
            explicit_to: false,
            absolute: false,
        }),
        _ => Some(DrawingAnchor {
            from_row,
            from_column,
            from_row_offset,
            from_column_offset,
            to_row: from_row + 20,
            to_column: from_column + 8,
            to_row_offset: 0,
            to_column_offset: 0,
            explicit_to: false,
            absolute: false,
        }),
    }
}
