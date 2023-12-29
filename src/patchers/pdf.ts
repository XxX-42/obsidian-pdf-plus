import { Notice, TFile } from "obsidian";
import { around } from "monkey-around";

import PDFPlus from "main";
import { ColorPalette } from "color-palette";
import { BacklinkHighlighter } from "highlight";
import { PDFPlusTemplateProcessor } from "template";
import { registerPDFEvent } from "utils";
import { ObsidianViewer, PDFToolbar, PDFView, PDFViewer, PDFViewerChild } from "typings";


export const patchPDF = (plugin: PDFPlus): boolean => {
    const app = plugin.app;
    const pdfView = app.workspace.getLeavesOfType("pdf")[0]?.view as PDFView | undefined;
    if (!pdfView) return false;
    const child = pdfView.viewer.child;
    if (!child) return false;
    const viewer = child.pdfViewer;
    if (!viewer) return false;
    const toolbar = child.toolbar;
    if (!toolbar) return false;

    plugin.register(around(pdfView.viewer.constructor.prototype, {
        onload(old) {
            return function () {
                const ret = old.call(this);
                const self = this as PDFViewer;
                self.then((child) => {
                    if (!self.backlinkHighlighter) {
                        self.backlinkHighlighter = self.addChild(new BacklinkHighlighter(plugin, child.pdfViewer));
                    }
                    if (!child.backlinkHighlighter) {
                        child.backlinkHighlighter = self.backlinkHighlighter
                    }
                });
                return ret;
            }
        },
        loadFile(old) {
            return async function (file: TFile, subpath?: string) {
                const ret = await old.call(this, file, subpath);
                const self = this as PDFViewer;
                self.then((child) => {
                    if (!self.backlinkHighlighter) {
                        self.backlinkHighlighter = self.addChild(new BacklinkHighlighter(plugin, child.pdfViewer));
                    }
                    if (!child.backlinkHighlighter) {
                        child.backlinkHighlighter = self.backlinkHighlighter
                    }
                    self.backlinkHighlighter.file = file;
                    self.backlinkHighlighter.highlightBacklinks();

                    child.file = file;
                });
                return ret;
            }
        }
    }));

    plugin.register(around(child.constructor.prototype, {
        onResize(old) {
            return function () {
                const self = this as PDFViewerChild;
                const ret = old.call(this);
                plugin.pdfViwerChildren.set(self.containerEl.find('.pdf-viewer'), self);
                return ret;
            }
        },
        getMarkdownLink(old) {
            return function (subpath?: string, alias?: string, embed?: boolean): string {
                return old.call(this, subpath, plugin.settings.alias ? alias : undefined, embed);
            }
        },
        getPageLinkAlias(old) {
            return function (page: number): string {
                if (plugin.settings.aliasFormat) {
                    const self = this as PDFViewerChild;
                    let alias = '';
                    try {
                        const selection = window.getSelection()?.toString().replace(/[\r\n]+/g, " ");
                        alias = new PDFPlusTemplateProcessor(plugin, {}, this.file, page, self.pdfViewer.pagesCount, selection).evalTemplate(plugin.settings.aliasFormat);
                    } catch (err) {
                        console.error(err);
                        new Notice(`${plugin.manifest.name}: Display text format is invalid. Error: ${err.message}`, 3000);
                    }
                    return alias.trim();
                }
                return old.call(this, page);
            }
        },
        highlightText(old) {
            return function (page: number, range: [[number, number], [number, number]]) {
                const self = this as PDFViewerChild;

                const indexFirst = range[0][0];
                const pageViewFirst = self.getPage(page);
                const textDivFirst = pageViewFirst.textLayer?.textDivs[indexFirst];

                if (plugin.settings.trimSelectionEmbed
                    && self.pdfViewer.isEmbed
                    && self.pdfViewer.dom
                    && !(plugin.settings.ignoreHeightParamInPopoverPreview
                        && self.pdfViewer.dom.containerEl.parentElement?.matches('.hover-popover'))
                ) {
                    const indexLast = range[1][0];
                    const pageViewLast = self.getPage(page);
                    const textDivLast = pageViewLast.textLayer?.textDivs[indexLast];

                    if (textDivFirst && textDivLast) {
                        setTimeout(() => {
                            const containerRect = self.pdfViewer.dom!.viewerContainerEl.getBoundingClientRect();
                            const firstRect = textDivFirst.getBoundingClientRect();
                            const lastRect = textDivLast.getBoundingClientRect();
                            const height = lastRect.bottom - firstRect.top + 2 * Math.abs(firstRect.top - containerRect.top);
                            self.pdfViewer.setHeight(height)
                        }, 100);
                    }
                }

                if (plugin.settings.noTextHighlightsInEmbed && self.pdfViewer.isEmbed) {
                    (window as any).pdfjsViewer.scrollIntoView(textDivFirst, {
                        top: - plugin.settings.embedMargin
                    }, true);
                    return;
                }

                const ret = old.call(this, page, range);

                (window as any).pdfjsViewer.scrollIntoView(textDivFirst, {
                    top: - plugin.settings.embedMargin
                }, true);

                plugin.trigger('highlighted', { type: 'selection', source: 'obsidian', pageNumber: page, child: self });

                return ret;
            }
        },
        highlightAnnotation(old) {
            return function (page: number, id: string) {
                const self = this as PDFViewerChild;

                const getAnnotationEl = () => {
                    if (self.annotationHighlight) return self.annotationHighlight;
                    const pageView = self.getPage(page);
                    return pageView.annotationLayer?.div.querySelector<HTMLElement>(`[data-annotation-id="${id}"]`);
                }

                if (plugin.settings.trimSelectionEmbed
                    && self.pdfViewer.isEmbed
                    && self.pdfViewer.dom
                    && !(plugin.settings.ignoreHeightParamInPopoverPreview
                        && self.pdfViewer.dom.containerEl.parentElement?.matches('.hover-popover'))
                ) {
                    setTimeout(() => {
                        const el = getAnnotationEl();
                        if (el) {
                            const containerRect = self.pdfViewer.dom!.viewerContainerEl.getBoundingClientRect();
                            const annotationRect = el.getBoundingClientRect();
                            const height = annotationRect.bottom - annotationRect.top + 2 * Math.abs(annotationRect.top - containerRect.top);
                            self.pdfViewer.setHeight(height)
                        }
                    }, 100);
                }

                const el = getAnnotationEl();

                if (plugin.settings.noTextHighlightsInEmbed && self.pdfViewer.isEmbed && el) {
                    activeWindow.setTimeout(() => {
                        (window as any).pdfjsViewer.scrollIntoView(el, {
                            top: - plugin.settings.embedMargin
                        }, true)
                    });
                    return;
                }

                const ret = old.call(this, page, id);

                activeWindow.setTimeout(() => {
                    (window as any).pdfjsViewer.scrollIntoView(el, {
                        top: - plugin.settings.embedMargin
                    }, true)
                });

                plugin.trigger('highlighted', { type: 'annotation', source: 'obsidian', pageNumber: page, child: self });

                return ret;
            }
        },
        clearTextHighlight(old) {
            return function () {
                const self = this as PDFViewerChild;
                if (plugin.settings.persistentTextHighlightsInEmbed && self.pdfViewer.isEmbed) {
                    return;
                }
                old.call(this);
            }
        },
        clearAnnotationHighlight(old) {
            return function () {
                const self = this as PDFViewerChild;
                if (plugin.settings.persistentAnnotationHighlightsInEmbed && self.pdfViewer.isEmbed) {
                    return;
                }
                old.call(this);
            }
        }
    }));

    plugin.register(around(Object.getPrototypeOf(viewer.constructor.prototype), {
        initialize(old) {
            return function () {
                const self = this as ObsidianViewer;
                const ret = old.call(this);

                if (plugin.settings.noSpreadModeInEmbed && self.isEmbed) {
                    registerPDFEvent('pagerendered', self.eventBus, null, () => {
                        self.eventBus.dispatch('switchspreadmode', { mode: 0 });
                    });
                }

                return ret;
            }
        }
    }));

    plugin.register(around(toolbar.constructor.prototype, {
        reset(old) {
            return function () {
                const self = this as PDFToolbar;
                // without setTimeout, the colorPaletteInEmbedToolbar option doesn't work for newly opened notes with PDF embeds
                setTimeout(() => new ColorPalette(plugin, self.toolbarLeftEl));
                old.call(this);
            }
        }
    }));

    return true;
}
