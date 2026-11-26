//! Workbook-level parts: sheet declarations and relationships,
//! `<dimension>` / sheet-view scans, the shared-string table and workbook
//! defined names.

use super::*;
use quick_xml::{NsReader, name::ResolveResult};
use roxmltree::Node;

pub(crate) const WORKBOOK_PATH: &str = "xl/workbook.xml";

const OFFICE_RELATIONSHIPS: &str =
    "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const STRICT_OFFICE_RELATIONSHIPS: &str = "http://purl.oclc.org/ooxml/officeDocument/relationships";

fn workbook_children<'a, 'input>(
    parent: Node<'a, 'input>,
    name: &'static str,
) -> impl Iterator<Item = Node<'a, 'input>> {
    parent.children().filter(move |node| {
        node.has_tag_name(name) && node.tag_name().namespace() == parent.tag_name().namespace()
    })
}

pub(crate) fn read_sheet_declarations(
    workbook: Node<'_, '_>,
) -> Result<
    (
        Vec<SheetDeclaration>,
        Option<WorkbookProtectionInfo>,
        usize,
        bool,
    ),
    SidecarError,
> {
    let child = |name| workbook_children(workbook, name).next();
    let enabled = |value| matches!(value, Some("1" | "true"));
    let date_1904 = enabled(child("workbookPr").and_then(|node| node.attribute("date1904")));
    let protection = child("workbookProtection").map(|node| WorkbookProtectionInfo {
        lock_structure: enabled(node.attribute("lockStructure")),
        has_password: node.attribute("workbookPassword").is_some()
            || node.attribute("workbookHashValue").is_some(),
    });
    let active_tab = child("bookViews")
        .into_iter()
        .flat_map(|node| workbook_children(node, "workbookView"))
        .filter_map(|node| node.attribute("activeTab"))
        .last()
        .and_then(|value| value.trim().parse().ok())
        .unwrap_or(0);
    let mut sheets = Vec::new();
    for sheet in child("sheets")
        .into_iter()
        .flat_map(|node| workbook_children(node, "sheet"))
    {
        let name = sheet
            .attribute("name")
            .ok_or_else(|| SidecarError::Workbook("Sheet has no name.".into()))?;
        let sheet_id = sheet
            .attribute("sheetId")
            .ok_or_else(|| SidecarError::Workbook("Sheet has no sheetId.".into()))?;
        let relationship_id = sheet
            .attribute((OFFICE_RELATIONSHIPS, "id"))
            .or_else(|| sheet.attribute((STRICT_OFFICE_RELATIONSHIPS, "id")))
            .or_else(|| sheet.attribute("id"));
        let state = sheet.attribute("state");
        sheets.push(SheetDeclaration {
            name: name.to_owned(),
            sheet_id: sheet_id.to_owned(),
            relationship_id: relationship_id.map(str::to_owned),
            hidden: matches!(state, Some("hidden" | "veryHidden")),
            very_hidden: state == Some("veryHidden"),
        });
    }
    Ok((sheets, protection, active_tab, date_1904))
}

pub(crate) struct WorkbookRelationships {
    pub(crate) targets: HashMap<String, String>,
    pub(crate) theme: String,
    pub(crate) styles: String,
    pub(crate) shared_strings: String,
}

pub(crate) fn read_workbook_relationships(
    archive: &mut ZipArchive<File>,
) -> Result<WorkbookRelationships, SidecarError> {
    let path = "xl/_rels/workbook.xml.rels";
    let xml = read_zip_string(archive, path)?;
    let document = visuals::parse_document(&xml, path)?;
    let relationships = || {
        document.root_element().children().filter(|node| {
            node.has_tag_name("Relationship") && node.attribute("TargetMode") != Some("External")
        })
    };
    let part_path = |kind: &str, fallback: &str| {
        relationships()
            .find_map(|node| {
                let (_, suffix) = node.attribute("Type")?.rsplit_once('/')?;
                if suffix == kind {
                    node.attribute("Target")
                } else {
                    None
                }
            })
            .map_or_else(
                || Ok(fallback.to_owned()),
                |target| crate::archive::resolve_relationship_target("xl/workbook.xml", target),
            )
    };
    Ok(WorkbookRelationships {
        targets: relationships()
            .filter(|node| {
                // Preserve compatibility with older parts that omitted Type.
                node.attribute("Type").is_none_or(|kind| {
                    kind.ends_with("/worksheet") || kind.ends_with("/chartsheet")
                })
            })
            .filter_map(|node| {
                Some((
                    node.attribute("Id")?.to_owned(),
                    node.attribute("Target")?.to_owned(),
                ))
            })
            .collect(),
        theme: part_path("theme", "xl/theme/theme1.xml")?,
        styles: part_path("styles", "xl/styles.xml")?,
        shared_strings: part_path("sharedStrings", "xl/sharedStrings.xml")?,
    })
}

pub(crate) fn normalize_worksheet_path(target: &str) -> Result<String, SidecarError> {
    let target = target.trim();
    let target = target
        .strip_prefix("xl/")
        .or_else(|| target.strip_prefix("xl\\"))
        .unwrap_or(target);
    crate::archive::resolve_relationship_target("xl/workbook.xml", target)
}

pub(crate) struct SheetDimensions {
    pub(crate) row_count: usize,
    pub(crate) column_count: usize,
    /// `<c>` elements carrying a value, formula or style; None when the
    /// workbook's counting budget ran out before this sheet was walked.
    pub(crate) stored_cell_count: Option<usize>,
    /// The subset of stored cells carrying a value or formula, and the
    /// (rows, columns) box those cells span; None with stored_cell_count.
    pub(crate) value_cell_count: Option<usize>,
    pub(crate) value_extent: Option<(usize, usize)>,
    pub(crate) column_widths: Vec<ColumnWidth>,
    pub(crate) default_row_height: Option<f64>,
    pub(crate) default_row_height_fixed: bool,
    pub(crate) default_column_width: Option<f64>,
    pub(crate) base_column_width: Option<f64>,
    pub(crate) freeze: Option<FreezePane>,
    pub(crate) tab_color: Option<String>,
    pub(crate) show_grid_lines: bool,
    pub(crate) show_formulas: bool,
    pub(crate) show_row_col_headers: bool,
    pub(crate) right_to_left: bool,
    pub(crate) zoom_scale: Option<u16>,
    pub(crate) outline_level_row: u8,
    pub(crate) outline_level_col: u8,
    pub(crate) outline_summary_below: bool,
    pub(crate) outline_summary_right: bool,
}

/// Excel keeps a zoom per view type; the app always opens the normal view,
/// so a sheet saved in page-break/layout view falls back to
/// zoomScaleNormal (absent = 100%). 100 maps to None so unzoomed sheets
/// serialize nothing.
pub(crate) fn normal_view_zoom(
    view: Option<&str>,
    zoom_scale: Option<u16>,
    zoom_scale_normal: Option<u16>,
) -> Option<u16> {
    let zoom = match view {
        Some("pageBreakPreview") | Some("pageLayout") => zoom_scale_normal,
        _ => zoom_scale.or(zoom_scale_normal),
    };
    zoom.map(|value| value.clamp(10, 400))
        .filter(|value| *value != 100)
}

pub(crate) fn read_sheet_dimensions(
    archive: &mut ZipArchive<File>,
    worksheet_path: &str,
    colors: &ColorContext,
    count_budget: &mut usize,
) -> Result<SheetDimensions, SidecarError> {
    let entry = zip_entry(archive, worksheet_path)?;
    let mut reader = Reader::from_reader(BufReader::new(entry));
    let mut buffer = Vec::new();
    let mut maximum_row = 0;
    let mut maximum_column = 0;
    // Implicit-address fallbacks, mirroring the cell-stream parser.
    let mut current_row = 0usize;
    let mut first_row = true;
    let mut next_column = 0usize;
    let mut dimensions = None;
    let mut column_widths = Vec::new();
    let mut default_row_height = None;
    let mut default_row_height_fixed = false;
    let mut default_column_width = None;
    let mut base_column_width = None;
    let mut freeze = None;
    let mut tab_color = None;
    let mut show_grid_lines = true;
    let mut show_formulas = false;
    let mut show_row_col_headers = true;
    let mut right_to_left = false;
    let mut zoom_scale = None;
    let mut dimension_trusted = false;
    let mut stored_cell_count = 0usize;
    let mut value_cell_count = 0usize;
    let mut value_extent = (0usize, 0usize);
    // Some(true) once the open <c> has shown a value/formula/style.
    let mut open_cell_stored: Option<bool> = None;
    let mut open_cell_position = (0usize, 0usize);
    let mut open_cell_has_value = false;
    let mut outline_level_row = 0u8;
    let mut outline_level_col = 0u8;
    let mut outline_summary_below = true;
    let mut outline_summary_right = true;
    let counted = loop {
        match reader.read_event_into(&mut buffer)? {
            Event::Start(element) | Event::Empty(element)
                if element.local_name().as_ref() == b"dimension" =>
            {
                if let Some(reference) = attribute_value(&reader, &element, b"ref")? {
                    // A malformed ref means "no usable dimension", not a broken file.
                    dimensions = dimensions_from_reference(&reference).ok();
                }
            }
            Event::Start(element) | Event::Empty(element)
                if element.local_name().as_ref() == b"outlinePr" =>
            {
                let flag = |name: &[u8]| -> Result<bool, SidecarError> {
                    Ok(!matches!(
                        attribute_value(&reader, &element, name)?.as_deref(),
                        Some("0") | Some("false")
                    ))
                };
                outline_summary_below = flag(b"summaryBelow")?;
                outline_summary_right = flag(b"summaryRight")?;
            }
            Event::Start(element) | Event::Empty(element)
                if element.local_name().as_ref() == b"tabColor" =>
            {
                tab_color = visuals::resolve_color(
                    attribute_value(&reader, &element, b"rgb")?.as_deref(),
                    attribute_value(&reader, &element, b"indexed")?.as_deref(),
                    attribute_value(&reader, &element, b"theme")?.as_deref(),
                    attribute_value(&reader, &element, b"tint")?.as_deref(),
                    colors,
                );
            }
            Event::Start(element) | Event::Empty(element)
                if element.local_name().as_ref() == b"sheetView" =>
            {
                if let Some(value) = attribute_value(&reader, &element, b"showGridLines")? {
                    show_grid_lines = value != "0" && value != "false";
                }
                if let Some(value) = attribute_value(&reader, &element, b"showFormulas")? {
                    show_formulas = value == "1" || value == "true";
                }
                if let Some(value) = attribute_value(&reader, &element, b"showRowColHeaders")? {
                    show_row_col_headers = value != "0" && value != "false";
                }
                if let Some(value) = attribute_value(&reader, &element, b"rightToLeft")? {
                    right_to_left = value == "1" || value == "true";
                }
                let percent = |name: &[u8]| -> Result<Option<u16>, SidecarError> {
                    Ok(attribute_value(&reader, &element, name)?
                        .and_then(|value| value.parse::<f64>().ok())
                        .filter(|value| *value > 0.0)
                        .map(|value| value.round() as u16))
                };
                zoom_scale = normal_view_zoom(
                    attribute_value(&reader, &element, b"view")?.as_deref(),
                    percent(b"zoomScale")?,
                    percent(b"zoomScaleNormal")?,
                );
            }
            Event::Start(element) | Event::Empty(element)
                if element.local_name().as_ref() == b"sheetFormatPr" =>
            {
                // defaultColWidth="0" is legal (Excel writes it with
                // zeroHeight="1" on all-hidden sheets) and means "no default —
                // use the built-in width"; normalize 0 to None (#173).
                default_row_height = attribute_value(&reader, &element, b"defaultRowHeight")?
                    .and_then(|value| value.parse::<f64>().ok())
                    .filter(|value| *value > 0.0);
                default_row_height_fixed = matches!(
                    attribute_value(&reader, &element, b"customHeight")?.as_deref(),
                    Some("1") | Some("true")
                );
                default_column_width = attribute_value(&reader, &element, b"defaultColWidth")?
                    .and_then(|value| value.parse::<f64>().ok())
                    .filter(|value| *value > 0.0);
                base_column_width = attribute_value(&reader, &element, b"baseColWidth")?
                    .and_then(|value| value.parse::<f64>().ok())
                    .filter(|value| *value > 0.0);
                let level = |name: &[u8]| -> Result<u8, SidecarError> {
                    Ok(attribute_value(&reader, &element, name)?
                        .and_then(|value| value.parse::<u8>().ok())
                        .map_or(0, |value| value.min(7)))
                };
                outline_level_row = level(b"outlineLevelRow")?;
                outline_level_col = level(b"outlineLevelCol")?;
            }
            Event::Start(element) | Event::Empty(element)
                if element.local_name().as_ref() == b"pane" =>
            {
                let state = attribute_value(&reader, &element, b"state")?;
                if matches!(state.as_deref(), Some("frozen") | Some("frozenSplit")) {
                    let split = |name: &[u8]| -> Result<usize, SidecarError> {
                        Ok(attribute_value(&reader, &element, name)?
                            .and_then(|value| value.parse::<f64>().ok())
                            .map(|value| value as usize)
                            .unwrap_or(0))
                    };
                    freeze = Some(FreezePane {
                        frozen_columns: split(b"xSplit")?,
                        frozen_rows: split(b"ySplit")?,
                    });
                }
            }
            Event::Start(element) | Event::Empty(element)
                if element.local_name().as_ref() == b"col" =>
            {
                let minimum = attribute_value(&reader, &element, b"min")?
                    .and_then(|value| value.parse::<usize>().ok());
                let maximum = attribute_value(&reader, &element, b"max")?
                    .and_then(|value| value.parse::<usize>().ok());
                let width = attribute_value(&reader, &element, b"width")?
                    .and_then(|value| value.parse::<f64>().ok());
                let hidden = attribute_value(&reader, &element, b"hidden")?
                    .is_some_and(|value| value == "1" || value == "true");
                let outline_level = attribute_value(&reader, &element, b"outlineLevel")?
                    .and_then(|value| value.parse::<u8>().ok())
                    .map(|value| value.min(7))
                    .filter(|value| *value > 0);
                let collapsed = attribute_value(&reader, &element, b"collapsed")?
                    .is_some_and(|value| value == "1" || value == "true");
                // xf 0 is the workbook default; carrying it would only bloat the metadata.
                let style_index = attribute_value(&reader, &element, b"style")?
                    .and_then(|value| value.parse::<usize>().ok())
                    .filter(|value| *value > 0);
                if let (Some(minimum), Some(maximum)) = (minimum, maximum) {
                    if width.is_some()
                        || hidden
                        || outline_level.is_some()
                        || collapsed
                        || style_index.is_some()
                    {
                        column_widths.push(ColumnWidth {
                            start_column: minimum.saturating_sub(1),
                            end_column: maximum.saturating_sub(1),
                            width,
                            hidden,
                            outline_level,
                            collapsed,
                            style_index,
                        });
                    }
                }
            }
            Event::Start(element)
                if element.local_name().as_ref() == b"sheetData"
                    // Single-row/column dimensions are the signature of writers
                    // that never update <dimension> (POI SXSSF, OpenXML SDK
                    // producers emitting A1 or A1:G1). Small dimensions can be
                    // stale too (tdf113271 declares A1:F5 over 462 rows) and
                    // are cheap to verify — trust only refs large enough that
                    // scanning them would cost real time. A ref reaching the
                    // sheet's last column or row (A1:XFD32, Yozo) declares the
                    // whole sheet, not the used range. A trusted ref still
                    // walks the cells, count-only, within the counting budget.
                    && dimensions.is_some_and(|(rows, columns)| {
                        rows > 1
                            && columns > 1
                            && !spans_full_axis(rows, columns)
                            && rows * columns >= DIMENSION_TRUST_CELLS
                    }) =>
            {
                dimension_trusted = true;
                if *count_budget == 0 {
                    let (row_count, column_count) = dimensions.unwrap_or((1, 1));
                    break (row_count, column_count, false);
                }
            }
            Event::End(element)
                if element.local_name().as_ref() == b"sheetData" && dimension_trusted =>
            {
                let (row_count, column_count) = dimensions.unwrap_or((1, 1));
                *count_budget -= stored_cell_count;
                break (row_count, column_count, true);
            }
            Event::Start(element) | Event::Empty(element)
                if element.local_name().as_ref() == b"row" =>
            {
                current_row = attribute_value(&reader, &element, b"r")?
                    .and_then(|value| value.parse::<usize>().ok())
                    .filter(|value| *value > 0)
                    .map(|value| value - 1)
                    .unwrap_or(if first_row { 0 } else { current_row + 1 });
                first_row = false;
                next_column = 0;
                maximum_row = maximum_row.max(current_row);
            }
            Event::Start(element) if element.local_name().as_ref() == b"c" => {
                let (row, column) = match attribute_value(&reader, &element, b"r")? {
                    Some(address) => parse_address(&address).unwrap_or((current_row, next_column)),
                    None => (current_row, next_column),
                };
                next_column = column + 1;
                maximum_row = maximum_row.max(row);
                maximum_column = maximum_column.max(column);
                open_cell_stored = Some(attribute_value(&reader, &element, b"s")?.is_some());
                open_cell_position = (row, column);
                open_cell_has_value = false;
            }
            Event::Empty(element) if element.local_name().as_ref() == b"c" => {
                let (row, column) = match attribute_value(&reader, &element, b"r")? {
                    Some(address) => parse_address(&address).unwrap_or((current_row, next_column)),
                    None => (current_row, next_column),
                };
                next_column = column + 1;
                maximum_row = maximum_row.max(row);
                maximum_column = maximum_column.max(column);
                if attribute_value(&reader, &element, b"s")?.is_some() {
                    stored_cell_count += 1;
                }
                if dimension_trusted && stored_cell_count >= *count_budget {
                    let (row_count, column_count) = dimensions.unwrap_or((1, 1));
                    *count_budget = 0;
                    break (row_count, column_count, false);
                }
            }
            Event::Start(element) | Event::Empty(element)
                if open_cell_stored.is_some()
                    && matches!(element.local_name().as_ref(), b"v" | b"f" | b"is") =>
            {
                open_cell_stored = Some(true);
                open_cell_has_value = true;
            }
            Event::End(element) if element.local_name().as_ref() == b"c" => {
                if open_cell_stored.take() == Some(true) {
                    stored_cell_count += 1;
                }
                if open_cell_has_value {
                    value_cell_count += 1;
                    value_extent.0 = value_extent.0.max(open_cell_position.0 + 1);
                    value_extent.1 = value_extent.1.max(open_cell_position.1 + 1);
                }
                if dimension_trusted && stored_cell_count >= *count_budget {
                    let (row_count, column_count) = dimensions.unwrap_or((1, 1));
                    *count_budget = 0;
                    break (row_count, column_count, false);
                }
            }
            Event::Eof => {
                let (dim_rows, dim_columns) = dimensions.unwrap_or((0, 0));
                let (row_count, column_count) = (
                    declared_extent(dim_rows, SHEET_MAX_ROWS).max(maximum_row + 1),
                    declared_extent(dim_columns, SHEET_MAX_COLUMNS).max(maximum_column + 1),
                );
                break (row_count, column_count, true);
            }
            _ => {}
        }
        buffer.clear();
    };
    let (row_count, column_count, counted) = counted;
    Ok(SheetDimensions {
        row_count,
        column_count,
        stored_cell_count: counted.then_some(stored_cell_count),
        value_cell_count: counted.then_some(value_cell_count),
        value_extent: counted.then_some(value_extent),
        column_widths,
        default_row_height,
        default_row_height_fixed,
        default_column_width,
        base_column_width,
        freeze,
        tab_color,
        show_grid_lines,
        show_formulas,
        show_row_col_headers,
        right_to_left,
        zoom_scale,
        outline_level_row,
        outline_level_col,
        outline_summary_below,
        outline_summary_right,
    })
}

pub(crate) const DIMENSION_TRUST_CELLS: usize = 10_000;
/// Per-workbook budget for counting stored cells on trusted dimensions
/// (under half a microsecond per cell at open). Every host gate sits below it, so a
/// workbook that exhausts it is "too large" either way; sheets the budget
/// never reached report no count and the host falls back to their box.
pub(crate) const STORED_CELL_COUNT_BUDGET: usize = 2_000_000;
pub(crate) const SHEET_MAX_ROWS: usize = 1_048_576;
pub(crate) const SHEET_MAX_COLUMNS: usize = 16_384;

/// A declared extent reaching the sheet's last row/column means "whole
/// sheet", not a used range; only the measured cells count then.
fn declared_extent(declared: usize, sheet_max: usize) -> usize {
    if declared >= sheet_max { 0 } else { declared }
}

fn spans_full_axis(rows: usize, columns: usize) -> bool {
    rows >= SHEET_MAX_ROWS || columns >= SHEET_MAX_COLUMNS
}

pub(crate) fn dimensions_from_reference(reference: &str) -> Result<(usize, usize), SidecarError> {
    let last = reference
        .split(':')
        .next_back()
        .unwrap_or(reference)
        .replace('$', "");
    let (row, column) = parse_address(&last)?;
    Ok((row + 1, column + 1))
}

pub(crate) fn read_shared_strings(
    archive: &mut ZipArchive<File>,
    path: &str,
    colors: &ColorContext,
) -> Result<Vec<SharedString>, SidecarError> {
    let Ok(entry) = zip_entry(archive, path) else {
        return Ok(Vec::new());
    };
    #[derive(Clone, Copy, PartialEq, Eq)]
    enum Element {
        Table,
        Item,
        Run,
        RunProperties,
        RunProperty,
        Text,
        Other,
    }

    let mut reader = NsReader::from_reader(BufReader::new(entry));
    let mut buffer = Vec::new();
    let mut parents = Vec::new();
    let mut table_namespace = Vec::new();
    let mut strings = Vec::new();
    let mut current = String::new();
    let mut runs: Vec<RichRun> = Vec::new();
    let mut current_run: Option<RichRun> = None;
    let mut text_preserve = false;
    let mut text_node = String::new();
    loop {
        let event = reader.read_event_into(&mut buffer)?;
        match event {
            Event::Start(ref element) | Event::Empty(ref element) => {
                let start = matches!(event, Event::Start(_));
                let (resolved, local) = reader.resolve_element(element.name());
                let namespace = match resolved {
                    ResolveResult::Unbound => Some(&[][..]),
                    ResolveResult::Bound(namespace) => Some(namespace.into_inner()),
                    ResolveResult::Unknown(_) => None,
                };
                let parent = parents.last().copied();
                let tag = if parent.is_none()
                    && local.as_ref() == b"sst"
                    && matches!(
                        namespace,
                        Some(
                            b"" | b"http://schemas.openxmlformats.org/spreadsheetml/2006/main"
                                | b"http://purl.oclc.org/ooxml/spreadsheetml/main"
                        )
                    ) {
                    table_namespace = namespace.unwrap_or_default().to_vec();
                    Element::Table
                } else if namespace == Some(table_namespace.as_slice()) {
                    match (parent, local.as_ref()) {
                        (Some(Element::Table), b"si") => Element::Item,
                        (Some(Element::Item), b"r") => Element::Run,
                        (Some(Element::Run), b"rPr") => Element::RunProperties,
                        (Some(Element::RunProperties), _) => Element::RunProperty,
                        (Some(Element::Item | Element::Run), b"t") => Element::Text,
                        _ => Element::Other,
                    }
                } else {
                    Element::Other
                };

                match tag {
                    // Empty items still occupy a shared-string index.
                    Element::Item if !start => strings.push(SharedString {
                        text: String::new(),
                        runs: None,
                    }),
                    Element::Run if start => current_run = Some(RichRun::default()),
                    Element::Run => runs.push(RichRun::default()),
                    Element::RunProperty => {
                        if let Some(run) = &mut current_run {
                            apply_run_property(run, &reader, element, colors)?;
                        }
                    }
                    Element::Text if start => {
                        text_preserve = preserves_space(&reader, element)?;
                    }
                    _ => {}
                }
                if start {
                    parents.push(tag);
                }
            }
            Event::Text(text) if parents.last() == Some(&Element::Text) => {
                text_node.push_str(&decode_text(&text)?);
            }
            Event::CData(text) if parents.last() == Some(&Element::Text) => {
                text_node.push_str(&decode_cdata(&text)?);
            }
            Event::GeneralRef(reference) if parents.last() == Some(&Element::Text) => {
                text_node.push_str(&general_ref_text(&reference)?);
            }
            Event::End(_) => match parents.pop() {
                Some(Element::Text) => {
                    let text = text_node_content(std::mem::take(&mut text_node), text_preserve);
                    current.push_str(&text);
                    if let Some(run) = &mut current_run {
                        run.text.push_str(&text);
                    }
                }
                Some(Element::Run) => {
                    if let Some(run) = current_run.take() {
                        runs.push(run);
                    }
                }
                Some(Element::Item) => {
                    for run in &mut runs {
                        normalize_cell_text(&mut run.text);
                    }
                    normalize_cell_text(&mut current);
                    strings.push(SharedString {
                        text: std::mem::take(&mut current),
                        runs: qualify_runs(std::mem::take(&mut runs)),
                    });
                }
                _ => {}
            },
            Event::Eof => break,
            _ => {}
        }
        buffer.clear();
    }
    Ok(strings)
}

pub(crate) fn has_run_formatting(run: &RichRun) -> bool {
    run.bold
        || run.italic
        || run.underline
        || run.strikethrough
        || run.color.is_some()
        || run.size.is_some()
        || run.family.is_some()
        || run.vert_align.is_some()
}

pub(crate) fn qualify_runs(runs: Vec<RichRun>) -> Option<Vec<RichRun>> {
    (runs.len() > 1 || runs.iter().any(has_run_formatting)).then_some(runs)
}

/// Applies one rPr child element (b/i/u/strike/sz/rFont/color/vertAlign) to a run.
pub(crate) fn apply_run_property<R: std::io::BufRead>(
    run: &mut RichRun,
    reader: &Reader<R>,
    element: &BytesStart<'_>,
    colors: &ColorContext,
) -> Result<(), SidecarError> {
    // CT_BooleanProperty: presence means true unless val says otherwise —
    // POI writes explicit off flags as non-self-closing <strike val="0">.
    let flag_on = |value: Option<String>| !matches!(value.as_deref(), Some("0") | Some("false"));
    match element.local_name().as_ref() {
        b"b" => run.bold = flag_on(attribute_value(reader, element, b"val")?),
        b"i" => run.italic = flag_on(attribute_value(reader, element, b"val")?),
        b"u" => {
            run.underline = attribute_value(reader, element, b"val")?.as_deref() != Some("none");
        }
        b"strike" => run.strikethrough = flag_on(attribute_value(reader, element, b"val")?),
        b"sz" => {
            run.size = attribute_value(reader, element, b"val")?
                .and_then(|value| value.parse::<f64>().ok());
        }
        b"rFont" => run.family = attribute_value(reader, element, b"val")?,
        b"vertAlign" => {
            run.vert_align = attribute_value(reader, element, b"val")?
                .filter(|value| value == "subscript" || value == "superscript");
        }
        b"color" => {
            run.color = visuals::resolve_color(
                attribute_value(reader, element, b"rgb")?.as_deref(),
                attribute_value(reader, element, b"indexed")?.as_deref(),
                attribute_value(reader, element, b"theme")?.as_deref(),
                attribute_value(reader, element, b"tint")?.as_deref(),
                colors,
            );
        }
        _ => {}
    }
    Ok(())
}

/// Sheet-scoped `_xlnm.Print_Area` / `_xlnm.Print_Titles` formulas, keyed by
/// localSheetId (workbook sheet order).
#[derive(Default)]
pub(crate) struct SheetPrintNames {
    pub(crate) area: Option<String>,
    pub(crate) titles: Option<String>,
}

pub(crate) fn read_defined_names(
    workbook: Node<'_, '_>,
    sheet_count: usize,
) -> (
    Vec<DefinedName>,
    HashMap<usize, SheetPrintNames>,
    HashSet<usize>,
) {
    let mut names = Vec::new();
    let mut print_names: HashMap<usize, SheetPrintNames> = HashMap::new();
    let mut scoped_sheets = HashSet::new();
    for defined in workbook_children(workbook, "definedNames")
        .take(1)
        .flat_map(|section| workbook_children(section, "definedName"))
    {
        let Some(name) = defined.attribute("name").filter(|name| !name.is_empty()) else {
            continue;
        };
        let sheet_index = defined
            .attribute("localSheetId")
            .and_then(|index| index.trim().parse::<usize>().ok());
        if let Some(index) = sheet_index {
            if index >= sheet_count {
                continue;
            }
            // Hidden and built-in names also affect duplication.
            scoped_sheets.insert(index);
        }
        if defined.children().any(|node| node.is_element()) {
            continue;
        }
        let formula: String = defined
            .children()
            .filter(|node| node.is_text())
            .filter_map(|node| node.text())
            .collect();
        if formula.is_empty() {
            continue;
        }
        if name.starts_with("_xlnm") {
            // Print names feed PDF export. Other built-ins stay file-only.
            if let Some(index) = sheet_index.filter(|_| formula.len() <= 2_000) {
                match name {
                    "_xlnm.Print_Area" => {
                        print_names.entry(index).or_default().area = Some(formula)
                    }
                    "_xlnm.Print_Titles" => {
                        print_names.entry(index).or_default().titles = Some(formula);
                    }
                    _ => {}
                }
            }
        } else if !matches!(defined.attribute("hidden"), Some("1" | "true")) {
            names.push(DefinedName {
                name: name.to_owned(),
                formula: strip_future_function_markers(&formula),
                sheet_index,
            });
        }
    }
    (names, print_names, scoped_sheets)
}
