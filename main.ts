import { Plugin, WorkspaceWindow } from 'obsidian';
import { TikzjaxPluginSettings, DEFAULT_SETTINGS, TikzjaxSettingTab } from "./settings";
import { optimize } from "./svgo.browser";

// @ts-ignore
import tikzjaxJs from 'inline:./tikzjax.js';

const RENDER_TIMEOUT_MS = 30000;

export default class TikzjaxPlugin extends Plugin {
	settings: TikzjaxPluginSettings;
	private initializedDocs = new WeakSet<Document>();

	async onload() {
		await this.loadSettings();
		this.addSettingTab(new TikzjaxSettingTab(this.app, this));

		// Support pop-out windows
		this.app.workspace.onLayoutReady(() => {
			this.loadTikZJaxAllWindows();
			this.registerEvent(this.app.workspace.on("window-open", (win, window) => {
				this.loadTikZJax(window.document);
			}));
		});


		this.addSyntaxHighlighting();

		this.registerTikzCodeBlock();
	}

	onunload() {
		this.unloadTikZJaxAllWindows();
		this.removeSyntaxHighlighting();
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}


	// Patch tikzjax.js to add a timeout to the TeX Worker compilation.
	// Without this, a single hung texify() call blocks the serial render queue
	// forever, causing all subsequent diagrams to show a spinner indefinitely.
	patchTikZJaxJs(js: string): string {
		// 1. Wrap H.texify() with Promise.race + timeout so a hung Worker
		//    rejects after RENDER_TIMEOUT_MS instead of waiting forever
		const texifyOriginal = 'v=await H.texify(f,Object.assign({},A.dataset))';
		const texifyPatched = 'v=await Promise.race([H.texify(f,Object.assign({},A.dataset)),' +
			'new Promise(function(_,rj){setTimeout(function(){rj(new Error("TikZJax: render timed out after ' +
			RENDER_TIMEOUT_MS / 1000 + 's"))},' + RENDER_TIMEOUT_MS + ')})])';

		if (js.indexOf(texifyOriginal) === -1) {
			console.warn('TikZJax: could not find texify call site to patch — timeout will not be applied');
			return js;
		}

		js = js.replace(texifyOriginal, texifyPatched);

		// 2. Replace the broken-image error indicator with a visible error message
		const errorOriginal = "q.outerHTML=\"<img src='//invalid.site/img-not-found.png'/>\"";
		const errorPatched = 'q.outerHTML="<div style=\\"color:var(--text-error);' +
			'padding:8px 12px;border:1px solid var(--text-error);border-radius:4px;' +
			'font-family:var(--font-monospace);font-size:12px;white-space:pre-wrap' +
			'\\">TikZJax error: "+A.message+"</div>"';

		js = js.replace(errorOriginal, errorPatched);

		return js;
	}

	loadTikZJax(doc: Document) {
		if (this.initializedDocs.has(doc)) {
			return;
		}

		if (!doc.getElementById("tikzjax")) {
			const s = doc.createElement("script");
			s.id = "tikzjax";
			s.type = "text/javascript";
			s.innerText = this.patchTikZJaxJs(tikzjaxJs);

			const target = doc.body ?? doc.head ?? doc.documentElement;
			target.appendChild(s);
		}

		doc.addEventListener("tikzjax-load-finished", this.postProcessSvg);
		this.initializedDocs.add(doc);
	}

	unloadTikZJax(doc: Document) {
		const s = doc.getElementById("tikzjax");
		s?.remove();

		doc.removeEventListener("tikzjax-load-finished", this.postProcessSvg);
		this.initializedDocs.delete(doc);
	}

	loadTikZJaxAllWindows() {
		for (const window of this.getAllWindows()) {
			this.loadTikZJax(window.document);
		}
	}

	unloadTikZJaxAllWindows() {
		for (const window of this.getAllWindows()) {
			this.unloadTikZJax(window.document);
		}
	}

	getAllWindows() {
		const windows = [];

		// push the main window's root split to the list
		windows.push(this.app.workspace.rootSplit.win);

		// @ts-ignore floatingSplit is undocumented
		const floatingSplit = this.app.workspace.floatingSplit;
		if (floatingSplit?.children) {
			floatingSplit.children.forEach((child: any) => {
				if (child instanceof WorkspaceWindow) {
					windows.push(child.win);
				}
			});
		}

		return windows;
	}


	registerTikzCodeBlock() {
		this.registerMarkdownCodeBlockProcessor("tikz", (source, el, ctx) => {
			// Ensure TikZJax is loaded in the rendering document.
			// This covers export/print contexts that use a separate document.
			this.loadTikZJax(el.ownerDocument);

			const tidiedSource = this.tidyTikzSource(source);

			const script = el.createEl("script");
			script.setAttribute("type", "text/tikz");
			script.setAttribute("data-show-console", "true");
			script.setText(tidiedSource);

			// Watch for stuck renders and retry once if the spinner is still
			// showing after the timeout. This handles the case where the
			// Worker completed the timed-out request and is available again.
			this.watchForStuckRender(el, tidiedSource);
		});
	}

	watchForStuckRender(el: HTMLElement, source: string, retried = false) {
		const timeoutId = window.setTimeout(() => {
			if (!el.isConnected) return;

			const svg = el.querySelector('svg');
			if (!svg) return;

			// A spinner SVG contains <animate> elements; a rendered diagram does not
			const isSpinner = svg.querySelector('animate') !== null;
			if (!isSpinner) return;

			if (!retried) {
				// First timeout — replace the stuck spinner with a fresh script
				// element so the MutationObserver in tikzjax.js picks it up again
				console.log('TikZJax: render appears stuck, retrying...');
				const script = el.createEl("script");
				script.setAttribute("type", "text/tikz");
				script.setAttribute("data-show-console", "true");
				script.setText(source);
				svg.replaceWith(script);

				this.watchForStuckRender(el, source, true);
			}
			// After retry timeout, the tikzjax.js timeout patch will have
			// already replaced the spinner with an error message, so we
			// don't need further action here.
		}, RENDER_TIMEOUT_MS + 2000); // slightly after the inner timeout

		this.register(() => clearTimeout(timeoutId));
	}


	addSyntaxHighlighting() {
		// @ts-ignore
		window.CodeMirror.modeInfo.push({name: "Tikz", mime: "text/x-latex", mode: "stex"});
	}

	removeSyntaxHighlighting() {
		// @ts-ignore
		window.CodeMirror.modeInfo = window.CodeMirror.modeInfo.filter(el => el.name != "Tikz");
	}

	tidyTikzSource(tikzSource: string) {

		// Remove non-breaking space characters, otherwise we get errors
		const remove = "&nbsp;";
		tikzSource = tikzSource.replaceAll(remove, "");


		let lines = tikzSource.split("\n");

		// Trim whitespace that is inserted when pasting in code, otherwise TikZJax complains
		lines = lines.map(line => line.trim());

		// Remove empty lines
		lines = lines.filter(line => line);


		return lines.join("\n");
	}


	colorSVGinDarkMode(svg: string) {
		// Replace the color "black" with currentColor (the current text color)
		// so that diagram axes, etc are visible in dark mode
		// And replace "white" with the background color

		svg = svg.replaceAll(/("#000"|"black")/g, `"currentColor"`)
				.replaceAll(/("#fff"|"white")/g, `"var(--background-primary)"`);

		return svg;
	}


	optimizeSVG(svg: string) {
		// Optimize the SVG using SVGO
		// Fixes misaligned text nodes on mobile

		return optimize(svg, {plugins:
			[
				{
					name: 'preset-default',
					params: {
						overrides: {
							// Don't use the "cleanupIDs" plugin
							// To avoid problems with duplicate IDs ("a", "b", ...)
							// when inlining multiple svgs with IDs
							cleanupIDs: false
						}
					}
				}
			]
		// @ts-ignore
		}).data;
	}


	postProcessSvg = (e: Event) => {

		const svgEl = e.target as HTMLElement;
		let svg = svgEl.outerHTML;

		if (this.settings.invertColorsInDarkMode) {
			svg = this.colorSVGinDarkMode(svg);
		}

		svg = this.optimizeSVG(svg);

		svgEl.outerHTML = svg;
	}
}

