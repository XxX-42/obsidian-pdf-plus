import PDFPlus from 'main';
import { PDFPlusModal } from 'modals';
import { Setting } from 'obsidian';


export class PDFOutlineTitleModal extends PDFPlusModal {
    next: ((title: string) => any)[] = [];
    title: string | null = null; // the title of an outline item
    modalTitle: string;
    submitted: boolean = false;

    constructor(plugin: PDFPlus, modalTitle: string) {
        super(plugin);
        this.modalTitle = modalTitle;

        this.scope.register([], 'Enter', () => {
            this.submitAndClose();
        });
    }

    presetTitle(title: string) {
        this.title = title;
        return this;
    }

    onOpen() {
        super.onOpen();

        this.titleEl.setText(`${this.plugin.manifest.name}: ${this.modalTitle}`);

        new Setting(this.contentEl)
            .setName('Title')
            .addText((text) => {
                if (this.title !== null) {
                    text.setValue(this.title);
                    text.inputEl.select();
                }
                text.inputEl.size = 30;
                text.inputEl.id = 'pdf-plus-outline-title-modal';
            });

        new Setting(this.contentEl)
            .addButton((button) => {
                button
                    .setButtonText('Add')
                    .setCta()
                    .onClick(() => {
                        this.submitAndClose();
                    });
            })
            .addButton((button) => {
                button
                    .setButtonText('Cancel')
                    .onClick(() => {
                        this.close();
                    });
            });
    }

    askTitle() {
        this.open();
        return this;
    }

    then(callback: (title: string) => any) {
        this.submitted && this.title !== null ? callback(this.title) : this.next.push(callback);
        return this;
    }

    submitAndClose() {
        const inputEl = this.contentEl.querySelector('#pdf-plus-outline-title-modal');
        if (inputEl instanceof HTMLInputElement) {
            this.title = inputEl.value;
            this.submitted = true;
            this.close();
        }
    }

    onClose() {
        if (this.submitted && this.title !== null) {
            this.next.forEach((callback) => callback(this.title!));
        }
    }
}
