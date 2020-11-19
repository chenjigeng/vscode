/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as DOM from 'vs/base/browser/dom';
import { renderMarkdown } from 'vs/base/browser/markdownRenderer';
import { raceCancellation } from 'vs/base/common/async';
import { CancellationTokenSource } from 'vs/base/common/cancellation';
import { IMarkdownString } from 'vs/base/common/htmlContent';
import { Disposable, DisposableStore } from 'vs/base/common/lifecycle';
import { IDimension } from 'vs/editor/common/editorCommon';
import { format } from 'vs/base/common/jsonFormatter';
import { applyEdits } from 'vs/base/common/jsonEdit';
import { IModeService } from 'vs/editor/common/services/modeService';
import { IOpenerService } from 'vs/platform/opener/common/opener';
import { IQuickInputService } from 'vs/platform/quickinput/common/quickInput';
import { EDITOR_BOTTOM_PADDING, EDITOR_TOP_PADDING } from 'vs/workbench/contrib/notebook/browser/constants';
import { CellFocusMode, CodeCellRenderTemplate, INotebookEditor } from 'vs/workbench/contrib/notebook/browser/notebookBrowser';
import { CodeCellViewModel } from 'vs/workbench/contrib/notebook/browser/viewModel/codeCellViewModel';
import { CellOutputKind, IInsetRenderOutput, IProcessedOutput, NotebookCellOutputsSplice, RenderOutputType } from 'vs/workbench/contrib/notebook/common/notebookCommon';
import { INotebookService } from 'vs/workbench/contrib/notebook/common/notebookService';
import { ITextFileService } from 'vs/workbench/services/textfile/common/textfiles';
import { ClickTargetType } from 'vs/workbench/contrib/notebook/browser/view/renderers/cellWidgets';
import { OutputElement } from 'vs/workbench/contrib/notebook/browser/view/renderers/cellOutput';

const OUTPUT_COUNT_LIMIT = 500;

export class CodeCell extends Disposable {
	private outputEntries = new Map<IProcessedOutput, OutputElement>();

	constructor(
		private notebookEditor: INotebookEditor,
		private viewCell: CodeCellViewModel,
		private templateData: CodeCellRenderTemplate,
		@INotebookService private notebookService: INotebookService,
		@IQuickInputService private readonly quickInputService: IQuickInputService,
		@IOpenerService readonly openerService: IOpenerService,
		@ITextFileService readonly textFileService: ITextFileService,
		@IModeService private readonly _modeService: IModeService
	) {
		super();

		const width = this.viewCell.layoutInfo.editorWidth;
		const lineNum = this.viewCell.lineCount;
		const lineHeight = this.viewCell.layoutInfo.fontInfo?.lineHeight || 17;
		const editorHeight = this.viewCell.layoutInfo.editorHeight === 0
			? lineNum * lineHeight + EDITOR_TOP_PADDING + EDITOR_BOTTOM_PADDING
			: this.viewCell.layoutInfo.editorHeight;

		this.layoutEditor(
			{
				width: width,
				height: editorHeight
			}
		);

		const cts = new CancellationTokenSource();
		this._register({ dispose() { cts.dispose(true); } });
		raceCancellation(viewCell.resolveTextModel(), cts.token).then(model => {
			if (model && templateData.editor) {
				templateData.editor.setModel(model);
				viewCell.attachTextEditor(templateData.editor);
				if (notebookEditor.getActiveCell() === viewCell && viewCell.focusMode === CellFocusMode.Editor && this.notebookEditor.hasFocus()) {
					templateData.editor?.focus();
				}

				const realContentHeight = templateData.editor?.getContentHeight();
				if (realContentHeight !== undefined && realContentHeight !== editorHeight) {
					this.onCellHeightChange(realContentHeight);
				}

				if (this.notebookEditor.getActiveCell() === this.viewCell && viewCell.focusMode === CellFocusMode.Editor && this.notebookEditor.hasFocus()) {
					templateData.editor?.focus();
				}
			}
		});

		const updateForFocusMode = () => {
			if (viewCell.focusMode === CellFocusMode.Editor) {
				templateData.editor?.focus();
			}

			templateData.container.classList.toggle('cell-editor-focus', viewCell.focusMode === CellFocusMode.Editor);
		};
		const updateForCollapseState = () => {
			this.viewUpdate();
		};
		this._register(viewCell.onDidChangeState((e) => {
			if (e.focusModeChanged) {
				updateForFocusMode();
			}
		}));
		updateForFocusMode();

		templateData.editor?.updateOptions({ readOnly: !(viewCell.getEvaluatedMetadata(notebookEditor.viewModel!.metadata).editable) });
		this._register(viewCell.onDidChangeState((e) => {
			if (e.metadataChanged) {
				templateData.editor?.updateOptions({ readOnly: !(viewCell.getEvaluatedMetadata(notebookEditor.viewModel!.metadata).editable) });

				// TODO@rob this isn't nice
				this.viewCell.layoutChange({});
				updateForCollapseState();
				this.relayoutCell();
			}
		}));

		this._register(viewCell.onDidChangeState((e) => {
			if (e.languageChanged) {
				const mode = this._modeService.create(viewCell.language);
				templateData.editor?.getModel()?.setMode(mode.languageIdentifier);
			}
		}));

		this._register(viewCell.onDidChangeLayout((e) => {
			if (e.outerWidth !== undefined) {
				const layoutInfo = templateData.editor!.getLayoutInfo();
				if (layoutInfo.width !== viewCell.layoutInfo.editorWidth) {
					this.onCellWidthChange();
				}
			}
		}));

		this._register(templateData.editor!.onDidContentSizeChange((e) => {
			if (e.contentHeightChanged) {
				if (this.viewCell.layoutInfo.editorHeight !== e.contentHeight) {
					this.onCellHeightChange(e.contentHeight);
				}
			}
		}));

		this._register(templateData.editor!.onDidChangeCursorSelection((e) => {
			if (e.source === 'restoreState') {
				// do not reveal the cell into view if this selection change was caused by restoring editors...
				return;
			}

			const primarySelection = templateData.editor!.getSelection();

			if (primarySelection) {
				this.notebookEditor.revealLineInViewAsync(viewCell, primarySelection!.positionLineNumber);
			}
		}));

		this._register(viewCell.onDidChangeLayout(() => {
			this.outputEntries.forEach((value, key) => {
				const index = viewCell.outputs.indexOf(key);
				if (index >= 0) {
					const top = this.viewCell.getOutputOffsetInContainer(index);
					value.domNode.style.top = `${top}px`;
				}
			});

		}));

		// Apply decorations
		this._register(viewCell.onCellDecorationsChanged((e) => {
			e.added.forEach(options => {
				if (options.className) {
					templateData.rootContainer.classList.add(options.className);
				}

				if (options.outputClassName) {
					this.notebookEditor.deltaCellOutputContainerClassNames(this.viewCell.id, [options.outputClassName], []);
				}
			});

			e.removed.forEach(options => {
				if (options.className) {
					templateData.rootContainer.classList.remove(options.className);
				}

				if (options.outputClassName) {
					this.notebookEditor.deltaCellOutputContainerClassNames(this.viewCell.id, [], [options.outputClassName]);
				}
			});
		}));

		viewCell.getCellDecorations().forEach(options => {
			if (options.className) {
				templateData.rootContainer.classList.add(options.className);
			}

			if (options.outputClassName) {
				this.notebookEditor.deltaCellOutputContainerClassNames(this.viewCell.id, [options.outputClassName], []);
			}
		});

		// Mouse click handlers
		this._register(templateData.statusBar.onDidClick(e => {
			if (e.type !== ClickTargetType.ContributedItem) {
				const target = templateData.editor.getTargetAtClientPoint(e.event.clientX, e.event.clientY - viewCell.getEditorStatusbarHeight());
				if (target?.position) {
					templateData.editor.setPosition(target.position);
					templateData.editor.focus();
				}
			}
		}));

		this._register(templateData.editor!.onMouseDown(e => {
			// prevent default on right mouse click, otherwise it will trigger unexpected focus changes
			// the catch is, it means we don't allow customization of right button mouse down handlers other than the built in ones.
			if (e.event.rightButton) {
				e.event.preventDefault();
			}
		}));

		// Focus Mode
		const updateFocusMode = () => viewCell.focusMode = templateData.editor!.hasWidgetFocus() ? CellFocusMode.Editor : CellFocusMode.Container;
		this._register(templateData.editor!.onDidFocusEditorWidget(() => {
			updateFocusMode();
		}));
		this._register(templateData.editor!.onDidBlurEditorWidget(() => {
			// this is for a special case:
			// users click the status bar empty space, which we will then focus the editor
			// so we don't want to update the focus state too eagerly
			if (document.activeElement?.contains(this.templateData.container)) {
				setTimeout(() => {
					updateFocusMode();
				}, 300);
			} else {
				updateFocusMode();
			}
		}));
		updateFocusMode();

		// Render Outputs
		this.renderOutputs(editorHeight);
		this._register(viewCell.onDidChangeOutputs((splices) => {
			this.updateOutputs(splices);
		}));
		// Need to do this after the intial renderOutput
		updateForCollapseState();
	}

	renderOutputs(editorHeight: number) {
		if (this.viewCell.outputs.length > 0) {
			let layoutCache = false;
			if (this.viewCell.layoutInfo.totalHeight !== 0 && this.viewCell.layoutInfo.editorHeight > editorHeight) {
				layoutCache = true;
				this.relayoutCell();
			}

			this.templateData.outputContainer!.style.display = 'block';
			// there are outputs, we need to calcualte their sizes and trigger relayout
			// @TODO@rebornix, if there is no resizable output, we should not check their height individually, which hurts the performance
			const outputsToRender = this.viewCell.outputs.slice(0, Math.min(OUTPUT_COUNT_LIMIT, this.viewCell.outputs.length));
			for (let index = 0; index < outputsToRender.length; index++) {
				const currOutput = this.viewCell.outputs[index];

				// always add to the end
				this.renderOutput(currOutput, index, undefined);
			}

			this.viewCell.editorHeight = editorHeight;
			if (this.viewCell.outputs.length > OUTPUT_COUNT_LIMIT) {
				this.templateData.outputShowMoreContainer.style.display = 'block';
				this.viewCell.updateOutputShowMoreContainerHeight(46);
			}

			if (layoutCache) {
				this.relayoutCellDebounced();
			} else {
				this.relayoutCell();
			}
		} else {
			// noop
			this.viewCell.editorHeight = editorHeight;
			this.relayoutCell();
			this.templateData.outputContainer!.style.display = 'none';
		}

		this.templateData.outputShowMoreContainer.innerText = '';
		this.templateData.outputShowMoreContainer.appendChild(this.generateShowMoreElement());
		// this.templateData.outputShowMoreContainer.style.top = `${this.viewCell.layoutInfo.outputShowMoreContainerOffset}px`;

		if (this.viewCell.outputs.length < OUTPUT_COUNT_LIMIT) {
			this.templateData.outputShowMoreContainer.style.display = 'none';
			this.viewCell.updateOutputShowMoreContainerHeight(0);
		}
	}

	updateOutputs(splices: NotebookCellOutputsSplice[]) {
		if (!splices.length) {
			return;
		}

		const previousOutputHeight = this.viewCell.layoutInfo.outputTotalHeight;

		if (this.viewCell.outputs.length) {
			this.templateData.outputContainer!.style.display = 'block';
		} else {
			this.templateData.outputContainer!.style.display = 'none';
		}

		const reversedSplices = splices.reverse();

		reversedSplices.forEach(splice => {
			this.viewCell.spliceOutputHeights(splice[0], splice[1], splice[2].map(_ => 0));
		});

		const removedKeys: IProcessedOutput[] = [];

		this.outputEntries.forEach((value, key) => {
			if (this.viewCell.outputs.indexOf(key) < 0) {
				// already removed
				removedKeys.push(key);
				// remove element from DOM
				this.templateData?.outputContainer?.removeChild(value.domNode);
				this.notebookEditor.removeInset(key);
			}
		});

		removedKeys.forEach(key => {
			this.outputEntries.get(key)?.dispose();
			this.outputEntries.delete(key);
		});

		let prevElement: HTMLElement | undefined = undefined;
		const outputsToRender = this.viewCell.outputs.slice(0, Math.min(OUTPUT_COUNT_LIMIT, this.viewCell.outputs.length));

		outputsToRender.reverse().forEach(output => {
			if (this.outputEntries.has(output)) {
				// already exist
				prevElement = this.outputEntries.get(output)!.domNode;
				return;
			}

			// newly added element
			const currIndex = this.viewCell.outputs.indexOf(output);
			this.renderOutput(output, currIndex, prevElement);
			prevElement = this.outputEntries.get(output)?.domNode;
		});

		if (this.viewCell.outputs.length > OUTPUT_COUNT_LIMIT) {
			this.templateData.outputShowMoreContainer.style.display = 'block';
			this.viewCell.updateOutputShowMoreContainerHeight(46);
		} else {
			this.templateData.outputShowMoreContainer.style.display = 'none';
		}

		const editorHeight = this.templateData.editor!.getContentHeight();
		this.viewCell.editorHeight = editorHeight;

		if (previousOutputHeight === 0 || this.viewCell.outputs.length === 0) {
			// first execution or removing all outputs
			this.relayoutCell();
		} else {
			this.relayoutCellDebounced();
		}
	}

	generateShowMoreElement(): any {
		const md: IMarkdownString = {
			value: `There are more than ${OUTPUT_COUNT_LIMIT} outputs, [show more ...](command:workbench.action.openLargeOutput)`,
			isTrusted: true,
			supportThemeIcons: true
		};

		const element = renderMarkdown(md, {
			actionHandler: {
				callback: (content) => {
					if (content === 'command:workbench.action.openLargeOutput') {
						const content = JSON.stringify(this.viewCell.outputs.map(output => {
							switch (output.outputKind) {
								case CellOutputKind.Text:
									return {
										outputKind: 'text',
										text: output.text
									};
								case CellOutputKind.Error:
									return {
										outputKind: 'error',
										ename: output.ename,
										evalue: output.evalue,
										traceback: output.traceback
									};
								case CellOutputKind.Rich:
									return {
										data: output.data,
										metadata: output.metadata
									};
							}
						}));
						const edits = format(content, undefined, {});
						const metadataSource = applyEdits(content, edits);

						return this.textFileService.untitled.resolve({
							associatedResource: undefined,
							mode: 'json',
							initialValue: metadataSource
						}).then(model => {
							const resource = model.resource;
							this.openerService.open(resource);
						});
					}

					return;
				},
				disposeables: new DisposableStore()
			}
		});

		element.classList.add('output-show-more');
		return element;
	}

	private viewUpdate(): void {
		if (this.viewCell.metadata?.inputCollapsed && this.viewCell.metadata.outputCollapsed) {
			this.viewUpdateAllCollapsed();
		} else if (this.viewCell.metadata?.inputCollapsed) {
			this.viewUpdateInputCollapsed();
		} else if (this.viewCell.metadata?.outputCollapsed && this.viewCell.outputs.length) {
			this.viewUpdateOutputCollapsed();
		} else {
			this.viewUpdateExpanded();
		}
	}

	private viewUpdateShowOutputs(): void {
		for (let index = 0; index < this.viewCell.outputs.length; index++) {
			const currOutput = this.viewCell.outputs[index];

			const renderedOutput = this.outputEntries.get(currOutput);
			if (renderedOutput && renderedOutput.renderResult) {
				if (renderedOutput.renderResult.type !== RenderOutputType.None) {
					this.notebookEditor.createInset(this.viewCell, renderedOutput.renderResult as IInsetRenderOutput, this.viewCell.getOutputOffset(index));
				} else {
					// Anything else, just update the height
					this.viewCell.updateOutputHeight(index, renderedOutput.domNode.clientHeight);
				}
			} else {
				// Wasn't previously rendered, render it now
				this.renderOutput(currOutput, index);
			}
		}

		this.relayoutCell();
	}

	private viewUpdateInputCollapsed(): void {
		DOM.hide(this.templateData.cellContainer);
		DOM.hide(this.templateData.runButtonContainer);
		DOM.show(this.templateData.collapsedPart);
		DOM.show(this.templateData.outputContainer);
		this.templateData.container.classList.toggle('collapsed', true);

		this.viewUpdateShowOutputs();

		this.relayoutCell();
	}

	private viewUpdateHideOuputs(): void {
		for (const e of this.outputEntries.keys()) {
			this.notebookEditor.hideInset(e);
		}
	}

	private viewUpdateOutputCollapsed(): void {
		DOM.show(this.templateData.cellContainer);
		DOM.show(this.templateData.runButtonContainer);
		DOM.show(this.templateData.collapsedPart);
		DOM.hide(this.templateData.outputContainer);

		this.viewUpdateHideOuputs();

		this.templateData.container.classList.toggle('collapsed', false);
		this.templateData.container.classList.toggle('output-collapsed', true);

		this.relayoutCell();
	}

	private viewUpdateAllCollapsed(): void {
		DOM.hide(this.templateData.cellContainer);
		DOM.hide(this.templateData.runButtonContainer);
		DOM.show(this.templateData.collapsedPart);
		DOM.hide(this.templateData.outputContainer);
		this.templateData.container.classList.toggle('collapsed', true);
		this.templateData.container.classList.toggle('output-collapsed', true);

		for (const e of this.outputEntries.keys()) {
			this.notebookEditor.hideInset(e);
		}

		this.relayoutCell();
	}

	private viewUpdateExpanded(): void {
		DOM.show(this.templateData.cellContainer);
		DOM.show(this.templateData.runButtonContainer);
		DOM.hide(this.templateData.collapsedPart);
		DOM.show(this.templateData.outputContainer);
		this.templateData.container.classList.toggle('collapsed', false);
		this.templateData.container.classList.toggle('output-collapsed', false);

		this.viewUpdateShowOutputs();

		this.relayoutCell();
	}

	private layoutEditor(dimension: IDimension): void {
		this.templateData.editor?.layout(dimension);
		this.templateData.statusBar.layout(dimension.width);
	}

	private onCellWidthChange(): void {
		const realContentHeight = this.templateData.editor!.getContentHeight();
		this.viewCell.editorHeight = realContentHeight;
		this.relayoutCell();

		this.layoutEditor(
			{
				width: this.viewCell.layoutInfo.editorWidth,
				height: realContentHeight
			}
		);

		// for contents for which we don't observe for dynamic height, update them manually
		this.viewCell.outputs.forEach((o, i) => {
			const renderedOutput = this.outputEntries.get(o);
			if (renderedOutput && renderedOutput.renderResult && renderedOutput.renderResult.type === RenderOutputType.None && !renderedOutput.renderResult.hasDynamicHeight) {
				this.viewCell.updateOutputHeight(i, renderedOutput.domNode.clientHeight);
			}
		});
	}

	private onCellHeightChange(newHeight: number): void {
		const viewLayout = this.templateData.editor!.getLayoutInfo();
		this.viewCell.editorHeight = newHeight;
		this.relayoutCell();
		this.layoutEditor(
			{
				width: viewLayout.width,
				height: newHeight
			}
		);
	}

	private renderOutput(currOutput: IProcessedOutput, index: number, beforeElement?: HTMLElement) {
		if (!this.outputEntries.has(currOutput)) {
			this.outputEntries.set(currOutput, new OutputElement(this.notebookEditor, this.notebookService, this.quickInputService, this.viewCell, this.templateData.outputContainer, currOutput));
		}

		this.outputEntries.get(currOutput)!.render(index, beforeElement);
	}

	relayoutCell() {
		if (this._timer !== null) {
			clearTimeout(this._timer);
		}

		this.notebookEditor.layoutNotebookCell(this.viewCell, this.viewCell.layoutInfo.totalHeight);
	}

	private _timer: number | null = null;

	relayoutCellDebounced() {
		if (this._timer !== null) {
			clearTimeout(this._timer);
		}

		this._timer = setTimeout(() => {
			this.notebookEditor.layoutNotebookCell(this.viewCell, this.viewCell.layoutInfo.totalHeight);
			this._timer = null;
		}, 200) as unknown as number | null;
	}

	dispose() {
		this.viewCell.detachTextEditor();
		this.outputEntries.forEach((value) => {
			value.dispose();
		});

		this.templateData.focusIndicatorLeft!.style.height = 'initial';

		super.dispose();
	}
}
