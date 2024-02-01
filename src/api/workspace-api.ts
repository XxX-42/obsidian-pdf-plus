import { EditableFileView, MarkdownView, OpenViewState, PaneType, TFile, WorkspaceLeaf, WorkspaceSplit, WorkspaceTabs, parseLinktext } from 'obsidian';

import { PDFPlusAPISubmodule } from './submodule';
import { BacklinkView, PDFView } from 'typings';


export type FineGrainedSplitDirection = 'right' | 'left' | 'down' | 'up';
export type ExtendedPaneType = Exclude<PaneType, 'split'> | '' | FineGrainedSplitDirection;


export class WorkspaceAPI extends PDFPlusAPISubmodule {

    iteratePDFViews(cb: (view: PDFView) => any) {
        this.app.workspace.getLeavesOfType('pdf').forEach((leaf) => cb(leaf.view as PDFView));
    }

    iterateBacklinkViews(cb: (view: BacklinkView) => any) {
        this.app.workspace.getLeavesOfType('backlink').forEach((leaf) => cb(leaf.view as BacklinkView));
    }

    getExistingPDFLeafOfFile(file: TFile): WorkspaceLeaf | undefined {
        return this.app.workspace.getLeavesOfType('pdf').find(leaf => {
            return leaf.view instanceof EditableFileView && leaf.view.file === file;
        });
    }

    getExistingPDFViewOfFile(file: TFile): PDFView | undefined {
        const leaf = this.getExistingPDFLeafOfFile(file);
        if (leaf) return leaf.view as PDFView
    }

    getActiveGroupLeaves() {
        // I belive using `activeLeaf` is inevitable here.
        const activeGroup = this.app.workspace.activeLeaf?.group;
        if (!activeGroup) return null;

        return this.app.workspace.getGroupLeaves(activeGroup);
    }

    async openMarkdownLink(linktext: string, sourcePath: string, line?: number) {
        const { path: linkpath } = parseLinktext(linktext);
        const file = this.app.metadataCache.getFirstLinkpathDest(linkpath, sourcePath);

        // 1. If the target markdown file is already opened, open the link in the same leaf
        // 2. If not, create a new leaf under the same parent split as the first existing markdown leaf
        let markdownLeaf: WorkspaceLeaf | null = null;
        let markdownLeafParent: WorkspaceSplit | null = null;
        this.app.workspace.iterateRootLeaves((leaf) => {
            if (markdownLeaf) return;

            let createInSameParent = true;

            if (leaf.view instanceof MarkdownView) {
                if (leaf.parentSplit instanceof WorkspaceTabs) {
                    const sharesSameTabParentWithThePDF = leaf.parentSplit.children.some((item) => {
                        if (item instanceof WorkspaceLeaf && item.view.getViewType() === 'pdf') {
                            const view = item.view as PDFView;
                            return view.file?.path === sourcePath;
                        }
                    });
                    if (sharesSameTabParentWithThePDF) {
                        createInSameParent = false;
                    }
                }

                if (createInSameParent) markdownLeafParent = leaf.parentSplit;

                if (leaf.view.file === file) {
                    markdownLeaf = leaf;
                }
            }
        });

        if (!markdownLeaf) {
            markdownLeaf = markdownLeafParent
                ? this.app.workspace.createLeafInParent(markdownLeafParent, -1)
                : this.getLeaf(this.plugin.settings.paneTypeForFirstMDLeaf);
        }

        const openViewState: OpenViewState = typeof line === 'number' ? { eState: { line } } : {};
        // Ignore the "dontActivateAfterOpenMD" option when opening a link in a tab in the same split as the current tab
        // I believe using activeLeaf (which is deprecated) is inevitable here
        if (!(markdownLeaf.parentSplit instanceof WorkspaceTabs && markdownLeaf.parentSplit === this.app.workspace.activeLeaf?.parentSplit)) {
            openViewState.active = !this.plugin.settings.dontActivateAfterOpenMD;
        }

        await markdownLeaf.openLinkText(linktext, sourcePath, openViewState);
        this.app.workspace.revealLeaf(markdownLeaf);

        return;
    }

    getLeaf(paneType: ExtendedPaneType | boolean) {
        if (paneType === '') paneType = false;
        if (typeof paneType === 'boolean' || ['tab', 'split', 'window'].contains(paneType)) {
            return this.app.workspace.getLeaf(paneType as PaneType | boolean);
        }
        return this.getLeafBySplit(paneType as FineGrainedSplitDirection);
    }

    getLeafBySplit(direction: FineGrainedSplitDirection) {
        const leaf = this.app.workspace.getMostRecentLeaf();
        if (leaf) {
            if (['right', 'left'].contains(direction)) {
                return this.app.workspace.createLeafBySplit(leaf, 'vertical', direction === 'left');
            } else if (['down', 'up'].contains(direction)) {
                return this.app.workspace.createLeafBySplit(leaf, 'horizontal', direction === 'up');
            }
        }
        return this.app.workspace.createLeafInParent(this.app.workspace.rootSplit, 0)
    }

    openPDFLinkTextInLeaf(leaf: WorkspaceLeaf, linktext: string, sourcePath: string, openViewState?: OpenViewState): Promise<void> {
        return leaf.openLinkText(linktext, sourcePath, openViewState).then(() => {
            this.app.workspace.revealLeaf(leaf);
            const view = leaf.view as PDFView;
            view.viewer.then((child) => {
                const duration = this.plugin.settings.highlightDuration;
                const { subpath } = parseLinktext(linktext);
                this.api.highlight.viewer.highlightSubpath(child, subpath, duration);
            });
        });
    }
}
