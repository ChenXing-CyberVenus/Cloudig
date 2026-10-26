// The pinned browser library's published declarations use extensionless ESM
// imports, incompatible with NodeNext. Describe only the API we consume;
// do not disable type checking for the rest of the project.
export class PptxViewer {
    static open(input:ArrayBuffer,container:HTMLElement,options:{externalMedia:"block";renderMode:"slide";fitMode:"contain";pdfjs:false;lazyMedia:boolean;lazySlides:boolean;
      zipLimits:{maxEntries:number;maxEntryUncompressedBytes:number;maxTotalUncompressedBytes:number}}):Promise<PptxViewer>;
    readonly currentSlideIndex:number;
    readonly slideCount:number;
    readonly slideWidth:number;
    readonly slideHeight:number;
    goToSlide(index:number):Promise<void>;
    destroy():void;
}
