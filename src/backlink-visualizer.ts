import { HoverParent, HoverPopover, Keymap, TFile, setIcon } from 'obsidian';

import PDFPlus from 'main';
import { PDFPlusComponent } from 'lib/component';
import { PDFBacklinkCache, PDFBacklinkIndex, PDFPageBacklinkIndex } from 'lib/pdf-backlink-index';
import { PDFPageView, PDFViewerChild } from 'typings';
import { isCanvas, isEmbed, isHoverPopover, isMouseEventExternal, isNonEmbedLike } from 'utils';
import { onBacklinkVisualizerContextMenu } from 'context-menu';
import { BidirectionalMultiValuedMap } from 'utils';


export class PDFBacklinkVisualizer extends PDFPlusComponent {
    file: TFile;
    _index?: PDFBacklinkIndex;

    constructor(plugin: PDFPlus, file: TFile) {
        super(plugin);
        this.file = file;
    }

    get index(): PDFBacklinkIndex {
        return this._index
            ?? (this._index = this.addChild(new PDFBacklinkIndex(this.plugin, this.file)));
    }

    processSelection(pageNumber: number, id: string, caches: Set<PDFBacklinkCache>) { }
    processAnnotation(pageNumber: number, id: string, caches: Set<PDFBacklinkCache>) { }
    processXYZ(pageNumber: number, id: string, caches: Set<PDFBacklinkCache>) { }
    processFitBH(pageNumber: number, id: string, caches: Set<PDFBacklinkCache>) { }
    processFitR(pageNumber: number, id: string, caches: Set<PDFBacklinkCache>) { }
}


export class BacklinkDomManager extends PDFPlusComponent {
    visualizer: PDFViewerBacklinkVisualizer;

    private pagewiseCacheToDomsMap = new Map<number, BidirectionalMultiValuedMap<PDFBacklinkCache, HTMLElement>>;
    private pagewiseStatus = new Map<number, { onPageReady: boolean, onTextLayerReady: boolean, onAnnotationLayerReady: boolean }>;

    constructor(visualizer: PDFViewerBacklinkVisualizer) {
        super(visualizer.plugin);
        this.visualizer = visualizer;
    }

    get file() {
        return this.visualizer.file;
    }

    getCacheToDomsMap(pageNumber: number) {
        let cacheToDoms = this.pagewiseCacheToDomsMap.get(pageNumber);
        if (!cacheToDoms) {
            cacheToDoms = new BidirectionalMultiValuedMap();
            this.pagewiseCacheToDomsMap.set(pageNumber, cacheToDoms);
        }

        return cacheToDoms;
    }

    clearDomInPage(pageNumber: number) {
        const cacheToDoms = this.getCacheToDomsMap(pageNumber);
        for (const el of cacheToDoms.values()) {
            // Avoid removing elements in the annotation layer
            if (el.closest('.pdf-plus-backlink-highlight-layer')) el.remove();
        }
        this.pagewiseCacheToDomsMap.delete(pageNumber);
        this.updateStatus(pageNumber, { onPageReady: false, onTextLayerReady: false, onAnnotationLayerReady: false });
    }

    clear() {
        for (const pageNumber of this.pagewiseCacheToDomsMap.keys()) {
            this.clearDomInPage(pageNumber);
        }
    }

    getStatus(pageNumber: number) {
        let status = this.pagewiseStatus.get(pageNumber);
        if (!status) {
            status = { onPageReady: false, onTextLayerReady: false, onAnnotationLayerReady: false };
            this.pagewiseStatus.set(pageNumber, status);
        }
        return status;
    }

    isPageProcessed(pageNumber: number) {
        const status = this.getStatus(pageNumber);
        return status.onPageReady && status.onTextLayerReady && status.onAnnotationLayerReady;
    }

    updateStatus(pageNumber: number, update: { onPageReady?: boolean, onTextLayerReady?: boolean, onAnnotationLayerReady?: boolean }) {
        const status = this.getStatus(pageNumber);
        Object.assign(status, update);
    }

    postProcessPageIfReady(pageNumber: number) {
        if (this.isPageProcessed(pageNumber)) {
            this.postProcessPage(pageNumber);
        }
    }

    postProcessPage(pageNumber: number) {
        const cacheToDoms = this.getCacheToDomsMap(pageNumber);
        for (const cache of cacheToDoms.keys()) {
            const color = cache.getColor();

            for (const el of cacheToDoms.get(cache)) {
                this.hookBacklinkOpeners(el, cache);
                this.hookBacklinkViewEventHandlers(el, cache);
                this.hookContextMenuHandler(el, cache);
                this.hookClassAdderOnMouseOver(el, cache);

                if (color?.type === 'name') {
                    el.dataset.highlightColor = color.name.toLowerCase();
                } else if (color?.type === 'rgb') {
                    const { r, g, b } = color.rgb;
                    el.setCssProps({
                        '--pdf-plus-color': `rgb(${r}, ${g}, ${b})`,
                        '--pdf-plus-backlink-icon-color': `rgb(${r}, ${g}, ${b})`,
                        '--pdf-plus-rect-color': `rgb(${r}, ${g}, ${b})`,
                    });
                }
            }
        }
    }

    hookBacklinkOpeners(el: HTMLElement, cache: PDFBacklinkCache) {
        const lineNumber = 'position' in cache.refCache ? cache.refCache.position.start.line : undefined;

        this.registerDomEvent(el, 'mouseover', (event) => {
            this.app.workspace.trigger('hover-link', {
                event,
                source: 'pdf-plus',
                hoverParent: this,
                targetEl: el,
                linktext: cache.sourcePath,
                sourcePath: this.file.path,
                state: typeof lineNumber === 'number' ? { scroll: lineNumber } : undefined
            });
        });

        this.registerDomEvent(el, 'dblclick', (event) => {
            if (this.plugin.settings.doubleClickHighlightToOpenBacklink) {
                const paneType = Keymap.isModEvent(event);
                if (paneType) {
                    this.app.workspace.openLinkText(cache.sourcePath, this.file.path, paneType, {
                        eState: typeof lineNumber === 'number' ? { scroll: lineNumber, line: lineNumber } : undefined
                    });
                    return;
                }
                this.lib.workspace.openMarkdownLinkFromPDF(cache.sourcePath, this.file.path, lineNumber);
            }
        });
    }

    hookBacklinkViewEventHandlers(el: HTMLElement, cache: PDFBacklinkCache) {
        this.registerDomEvent(el, 'mouseover', (event) => {
            // highlight the corresponding item in backlink pane
            if (this.plugin.settings.highlightBacklinksPane) {
                this.lib.workspace.iterateBacklinkViews((view) => {
                    if (this.file !== view.file) return;
                    if (!view.containerEl.isShown()) return;
                    if (!view.pdfManager) return;

                    const backlinkItemEl = view.pdfManager.findBacklinkItemEl(cache);
                    if (backlinkItemEl) {
                        backlinkItemEl.addClass('hovered-backlink');

                        // clear highlights in backlink pane
                        const listener = (event: MouseEvent) => {
                            if (isMouseEventExternal(event, backlinkItemEl)) {
                                backlinkItemEl.removeClass('hovered-backlink');
                                el.removeEventListener('mouseout', listener);
                            }
                        }
                        el.addEventListener('mouseout', listener);
                    }
                });
            }
        });
    }

    hookContextMenuHandler(el: HTMLElement, cache: PDFBacklinkCache) {
        this.registerDomEvent(el, 'contextmenu', (evt) => {
            onBacklinkVisualizerContextMenu(evt, this.visualizer, cache);
        });
    }

    hookClassAdderOnMouseOver(el: HTMLElement, cache: PDFBacklinkCache) {
        const pageNumber = cache.page;

        if (typeof pageNumber === 'number') {
            const className = 'is-hovered';

            el.addEventListener('mouseover', () => {
                for (const otherEl of this.getCacheToDomsMap(pageNumber).get(cache)) {
                    otherEl.addClass(className);
                }

                const onMouseOut = () => {
                    for (const otherEl of this.getCacheToDomsMap(pageNumber).get(cache)) {
                        otherEl.removeClass(className);
                    }
                    el.removeEventListener('mouseout', onMouseOut);
                };
                el.addEventListener('mouseout', onMouseOut);
            });
        }
    }
}


export class PDFViewerBacklinkVisualizer extends PDFBacklinkVisualizer implements HoverParent {
    child: PDFViewerChild;
    domManager: BacklinkDomManager;

    constructor(plugin: PDFPlus, file: TFile, child: PDFViewerChild) {
        super(plugin, file);
        this.child = child;
        this.domManager = new BacklinkDomManager(this);
    }

    static create(plugin: PDFPlus, file: TFile, child: PDFViewerChild) {
        return plugin.addChild(new PDFViewerBacklinkVisualizer(plugin, file, child));
    }

    get hoverPopover() {
        return this.child.hoverPopover;
    }

    set hoverPopover(hoverPopover: HoverPopover | null) {
        // We can add some post-processing if needed
        this.child.hoverPopover = hoverPopover;
    }

    onload() {
        if (!this.shouldVisualizeBacklinks()) return;

        this.visualize();
        this.registerEvent(this.index.on('update', () => {
            this.visualize()
        }));
    }

    shouldVisualizeBacklinks(): boolean {
        const viewer = this.child.pdfViewer;
        return this.settings.highlightBacklinks
            && (
                isNonEmbedLike(viewer)
                || (this.settings.highlightBacklinksInCanvas && isCanvas(viewer))
                || (this.settings.highlightBacklinksInHoverPopover && isHoverPopover(viewer))
                || (this.settings.highlightBacklinksInEmbed && isEmbed(viewer))
            );
    }

    visualize() {
        const viewer = this.child.pdfViewer;

        this.lib.onPageReady(viewer, this, (pageNumber) => {
            this.domManager.clearDomInPage(pageNumber);

            const pageIndex = this.index.getPageIndex(pageNumber);

            for (const [id, caches] of pageIndex.XYZs) {
                this.processXYZ(pageNumber, id, caches);
            }
            for (const [id, caches] of pageIndex.FitBHs) {
                this.processFitBH(pageNumber, id, caches);
            }
            for (const [id, caches] of pageIndex.FitRs) {
                this.processFitR(pageNumber, id, caches);
            }

            this.domManager.updateStatus(pageNumber, { onPageReady: true });
            this.domManager.postProcessPageIfReady(pageNumber);
        });

        this.lib.onTextLayerReady(viewer, this, (pageNumber) => {
            const status = this.domManager.getStatus(pageNumber);
            if (!status.onPageReady || status.onTextLayerReady) return;

            const pageIndex = this.index.getPageIndex(pageNumber);

            for (const [id, caches] of pageIndex.selections) {
                this.processSelection(pageNumber, id, caches);
            }

            this.domManager.updateStatus(pageNumber, { onTextLayerReady: true });
            this.domManager.postProcessPageIfReady(pageNumber);
        });

        this.lib.onAnnotationLayerReady(viewer, this, (pageNumber) => {
            const status = this.domManager.getStatus(pageNumber);
            if (!status.onPageReady || status.onAnnotationLayerReady) return;

            const pageIndex = this.index.getPageIndex(pageNumber);

            for (const [id, caches] of pageIndex.annotations) {
                this.processAnnotation(pageNumber, id, caches);
            }

            this.domManager.updateStatus(pageNumber, { onAnnotationLayerReady: true });
            this.domManager.postProcessPageIfReady(pageNumber);
        });
    }

    processSelection(pageNumber: number, id: string, caches: Set<PDFBacklinkCache>) {
        super.processSelection(pageNumber, id, caches);

        const pageView = this.child.getPage(pageNumber);
        const cacheToDoms = this.domManager.getCacheToDomsMap(pageNumber);
        const { beginIndex, beginOffset, endIndex, endOffset } = PDFPageBacklinkIndex.selectionIdToParams(id);

        const textLayer = pageView.textLayer;
        if (!textLayer) return;
        if (!textLayer.textDivs.length) return;

        const rects = this.lib.highlight.geometry.computeMergedHighlightRects(textLayer, beginIndex, beginOffset, endIndex, endOffset);

        for (const { rect, indices } of rects) {
            const rectEl = this.lib.highlight.viewer.placeRectInPage(rect, pageView);
            rectEl.addClasses(['pdf-plus-backlink', 'pdf-plus-backlink-selection']);

            // font-size is used to set the padding of this highlight in em unit
            const textDiv = textLayer.textDivs[indices[0]];
            rectEl.setCssStyles({
                fontSize: textDiv.style.fontSize
            });

            // indices of the text content items contained in this highlight (merged rectangle)
            rectEl.dataset.textIndices = indices.join(',');

            for (const cache of caches) {
                cacheToDoms.addValue(cache, rectEl);
            }
        }

        if (this.settings.showBacklinkIconForSelection) {
            const lastRect = rects.last()?.rect;
            if (lastRect) {
                const iconEl = this.showIcon(lastRect[2], lastRect[3], pageView);
                for (const cache of caches) {
                    cacheToDoms.addValue(cache, iconEl);
                }
            }
        }
    }

    processAnnotation(pageNumber: number, id: string, caches: Set<PDFBacklinkCache>) {
        super.processAnnotation(pageNumber, id, caches);

        const pageView = this.child.getPage(pageNumber);
        const annotationLayer = pageView.annotationLayer?.annotationLayer;
        if (!annotationLayer) return;
        const annot = annotationLayer.getAnnotation(id);
        if (!annot) return;
        annot.container.addClasses(['pdf-plus-backlink', 'pdf-plus-backlink-annotation']);

        const [, , right, top] = annot.data.rect;
        let iconEl: HTMLElement | undefined;
        if (this.settings.showBacklinkIconForAnnotation) {
            iconEl = this.showIcon(right, top, pageView);
        }

        let rectEl: HTMLElement | undefined;
        if (this.settings.showBoundingRectForBacklinkedAnnot) {
            rectEl = this.lib.highlight.viewer.placeRectInPage(annot.data.rect, pageView);
            rectEl.addClass('pdf-plus-annotation-bounding-rect');
        }

        const cacheToDoms = this.domManager.getCacheToDomsMap(pageNumber);
        for (const cache of caches) {
            cacheToDoms.addValue(cache, annot.container);
            if (iconEl) cacheToDoms.addValue(cache, iconEl);
            if (rectEl) cacheToDoms.addValue(cache, rectEl);

            const [r, g, b] = annot.data.color;
            cache.setColor({ rgb: { r, g, b } });
        }
    }

    processXYZ(pageNumber: number, id: string, caches: Set<PDFBacklinkCache>) {
        super.processXYZ(pageNumber, id, caches);

        if (this.settings.showBacklinkIconForOffset) {
            const pageView = this.child.getPage(pageNumber);
            const { left, top } = PDFPageBacklinkIndex.XYZIdToParams(id);
            const iconEl = this.showIcon(left, top, pageView, 'left');

            const cacheToDoms = this.domManager.getCacheToDomsMap(pageNumber);
            for (const cache of caches) {
                cacheToDoms.addValue(cache, iconEl);
            }
        }
    }

    processFitBH(pageNumber: number, id: string, caches: Set<PDFBacklinkCache>) {
        super.processFitBH(pageNumber, id, caches);

        if (this.settings.showBacklinkIconForOffset) {
            const pageView = this.child.getPage(pageNumber);
            const { top } = PDFPageBacklinkIndex.FitBHIdToParams(id);
            const iconEl = this.showIcon(0, top, pageView);

            const cacheToDoms = this.domManager.getCacheToDomsMap(pageNumber);
            for (const cache of caches) {
                cacheToDoms.addValue(cache, iconEl);
            }
        }
    }

    processFitR(pageNumber: number, id: string, caches: Set<PDFBacklinkCache>) {
        super.processFitR(pageNumber, id, caches);

        const pageView = this.child.getPage(pageNumber);
        const { left, bottom, right, top } = PDFPageBacklinkIndex.FitRIdToParams(id);
        const rectEl = this.lib.highlight.viewer.placeRectInPage([left, bottom, right, top], pageView);
        rectEl.addClasses(['pdf-plus-backlink', 'pdf-plus-backlink-fit-r']);

        const cacheToDoms = this.domManager.getCacheToDomsMap(pageNumber);
        for (const cache of caches) {
            cacheToDoms.addValue(cache, rectEl);
        }

        if (this.settings.showBacklinkIconForRect) {
            const iconEl = this.showIcon(right, top, pageView);
            for (const cache of caches) {
                cacheToDoms.addValue(cache, iconEl);
            }
        }
    }

    showIcon(x: number, y: number, pageView: PDFPageView, side: 'left' | 'right' = 'right') {
        // @ts-ignore
        const iconSize = Math.min(pageView.viewport.rawDims.pageWidth, pageView.viewport.rawDims.pageWidth) * this.settings.backlinkIconSize / 2000;
        const iconEl = side === 'right'
            ? this.lib.highlight.viewer.placeRectInPage([x, y - iconSize, x + iconSize, y], pageView)
            : this.lib.highlight.viewer.placeRectInPage([x - iconSize, y - iconSize, x, y], pageView);
        iconEl.addClass('pdf-plus-backlink-icon');
        setIcon(iconEl, 'links-coming-in');
        const svg = iconEl.querySelector<SVGElement>('svg');
        svg?.setAttribute('stroke', 'var(--pdf-plus-backlink-icon-color)');
        return iconEl;
    }
}


// class PDFCanvasBacklinkVisualizer extends PDFViewerBacklinkVisualizer {
//     // not implemented yet
// }


// class PDFExportBacklinkVisualizer extends PDFBacklinkVisualizer {
//     // not implemented yet
// }
