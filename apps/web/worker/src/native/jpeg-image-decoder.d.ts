declare module 'pdfjs-dist/image_decoders/pdf.image_decoders.mjs' {
  export class JpegImage {
    readonly width: number
    readonly height: number
    parse(bytes: Uint8Array, options: { dnlScanLines: number }): void
    getData(options: { width: number; height: number; forceRGBA: true }): Uint8ClampedArray
  }
}
