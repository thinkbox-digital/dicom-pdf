/** PDF.js standard fonts travel inside both viewers; no font URL or network fetch. */
export class BundledStandardFontDataFactory {
  constructor({fontData=typeof PDF_STANDARD_FONTS==='object'?PDF_STANDARD_FONTS:{}}={}){this.fontData=fontData;}
  async fetch({filename}){
    if(!Object.hasOwn(this.fontData,filename))throw new Error('This PDF standard font is not bundled.');
    const binary=atob(this.fontData[filename]);
    // A fresh view may be transferred to PDF.js without detaching a cached font.
    return Uint8Array.from(binary,character=>character.charCodeAt(0));
  }
}
export function bundledPdfFonts(){return {StandardFontDataFactory:BundledStandardFontDataFactory,useWorkerFetch:false};}
