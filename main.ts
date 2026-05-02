import { Plugin, WorkspaceWindow, TFile, MarkdownView } from 'obsidian';
import { TikzjaxPluginSettings, DEFAULT_SETTINGS, TikzjaxSettingTab } from "./settings";
import { optimize } from "./svgo.browser";

// @ts-ignore
import tikzjaxJs from 'inline:./tikzjax.js';

const RENDER_TIMEOUT_MS = 15000;

export default class TikzjaxPlugin extends Plugin {
	settings: TikzjaxPluginSettings;
	private initializedDocs = new WeakSet<Document>();
	private svgCache = new Map<string, string>();

	// %!include file cache: vault path → content
	private includeContentCache = new Map<string, string>();
	// Reverse map for auto-refresh: included vault path → Set of source note paths
	private includeMap = new Map<string, Set<string>>();

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

		// Auto-refresh notes when an included .tikz file is saved
		this.registerEvent(this.app.vault.on('modify', (file) => {
			if (!(file instanceof TFile)) { return; }
			this.includeContentCache.delete(file.path);
			const affectedNotes = this.includeMap.get(file.path);
			if (!affectedNotes?.size) { return; }
			for (const notePath of affectedNotes) {
				for (const leaf of this.app.workspace.getLeavesOfType('markdown')) {
					const view = leaf.view as MarkdownView;
					if ((view as any).file?.path === notePath) {
						// @ts-ignore rerender is not typed in the public API
						view.previewMode?.rerender(true);
					}
				}
			}
		}));

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


	// Patch tikzjax.js to:
	// 1. Add a timeout to the TeX Worker compilation
	// 2. Expose a cleanup function for full engine reset
	// 3. Replace broken-image error with visible error message
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

		// 2. Expose a cleanup function so the plugin can terminate the Worker
		//    and disconnect the MutationObserver for a full engine reset
		const initOriginal = 'window.TikzJax=!0,P().config';
		const initPatched = 'window.TikzJax=!0,window.__tikzjaxCleanup=async function(){' +
			'try{u&&u.disconnect()}catch(x){}' +
			'try{var W=await H;await e.terminate(W)}catch(x){}' +
			'window.TikzJax=!1' +
			'},P().config';

		if (js.indexOf(initOriginal) === -1) {
			console.warn('TikZJax: could not find init site to patch — reset will not be available');
		} else {
			js = js.replace(initOriginal, initPatched);
		}

		// 3. Replace the broken-image error indicator with a visible error message
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
		this.registerMarkdownCodeBlockProcessor("tikz", async (source, el, ctx) => {
			// Ensure TikZJax is loaded in the rendering document.
			// This covers export/print contexts that use a separate document.
			this.loadTikZJax(el.ownerDocument);

			// Resolve %!include directive (load external .tikz file from vault)
			source = await this.resolveInclude(source, ctx.sourcePath);

			const tidiedSource = this.tidyTikzSource(source);

			// Use cached SVG if available — critical for PDF export, where each
			// diagram is re-rendered in a fresh document and the async tikzjax
			// Worker may not finish before the PDF is captured.
			const cached = this.svgCache.get(tidiedSource);
			if (cached) {
				el.innerHTML = cached;
				return;
			}

			// Mark the container so postProcessSvg can store the result.
			el.dataset.tikzSource = tidiedSource;

			const script = el.createEl("script");
			script.setAttribute("type", "text/tikz");
			script.setAttribute("data-show-console", "true");
			script.setText(tidiedSource);

			// Watch for stuck renders — if the spinner is still showing after
			// the timeout, show an error with a retry button that does a
			// full engine reset (terminates Worker, re-injects tikzjax.js).
			this.watchForStuckRender(el, tidiedSource);
		});
	}

	/**
	 * Resolve a %!include directive at the top of a tikz source block.
	 *
	 * Syntax (first non-empty line of the block):
	 *   %!include path/to/diagram.tikz
	 *
	 * Path is relative to the source note's location in the vault.
	 * File content is cached; the cache is invalidated automatically when
	 * the vault fires a 'modify' event for the included file.
	 */
	async resolveInclude(source: string, sourcePath: string): Promise<string> {
		const firstLine = source.trim().split('\n')[0]?.trim();
		const match = firstLine?.match(/^%!include\s+(.+)$/);
		if (!match) { return source; }

		const includePath = match[1].trim();

		// Resolve relative to the source note's vault directory
		const noteDir = sourcePath.includes('/')
			? sourcePath.substring(0, sourcePath.lastIndexOf('/'))
			: '';
		const vaultPath = noteDir ? `${noteDir}/${includePath}` : includePath;

		// Track the dependency for auto-refresh on file save
		if (!this.includeMap.has(vaultPath)) {
			this.includeMap.set(vaultPath, new Set());
		}
		this.includeMap.get(vaultPath)!.add(sourcePath);

		// Return cached content if available
		const cached = this.includeContentCache.get(vaultPath);
		if (cached !== undefined) { return cached; }

		// Read from vault
		const file = this.app.vault.getAbstractFileByPath(vaultPath);
		if (file instanceof TFile) {
			const content = await this.app.vault.read(file);
			this.includeContentCache.set(vaultPath, content);
			return content;
		}

		return `% Error: cannot include ${includePath}`;
	}

	watchForStuckRender(el: HTMLElement, source: string) {
		const timeoutId = window.setTimeout(() => {
			if (!el.isConnected) return;

			// Check if still showing a spinner (SVG with <animate>) or
			// if tikzjax never even started (script element still present)
			const svg = el.querySelector('svg');
			const script = el.querySelector('script[type="text/tikz"]');
			const isStuck = script !== null || (svg !== null && svg.querySelector('animate') !== null);
			if (!isStuck) return;

			console.log('TikZJax: render appears stuck, performing full engine reset...');
			this.showRetryable(el, source, 'Render timed out');
		}, RENDER_TIMEOUT_MS + 2000); // slightly after the inner timeout

		this.register(() => clearTimeout(timeoutId));
	}

	showRetryable(el: HTMLElement, source: string, reason: string) {
		const doc = el.ownerDocument;
		el.empty();

		const errorDiv = el.createEl("div", { cls: "tikz-error" });
		errorDiv.createEl("span", { text: `TikZJax: ${reason}` });
		const retryBtn = errorDiv.createEl("button", {
			text: "Retry",
			cls: "tikz-retry-btn",
		});
		retryBtn.addEventListener("click", async () => {
			errorDiv.remove();
			await this.resetTikZJaxEngine(doc);

			const newScript = el.createEl("script");
			newScript.setAttribute("type", "text/tikz");
			newScript.setAttribute("data-show-console", "true");
			newScript.setText(source);

			this.watchForStuckRender(el, source);
		});
	}

	async resetTikZJaxEngine(doc: Document) {
		const win = doc.defaultView as any;

		// Use the exposed cleanup function to terminate Worker and disconnect observer
		if (typeof win?.__tikzjaxCleanup === 'function') {
			try {
				await win.__tikzjaxCleanup();
			} catch (e) {
				console.warn('TikZJax: cleanup failed', e);
			}
		}

		// Remove old script element
		doc.getElementById("tikzjax")?.remove();

		// Clear tracked state so loadTikZJax will re-initialize
		this.initializedDocs.delete(doc);

		// Re-inject tikzjax.js with fresh Worker and MutationObserver
		this.loadTikZJax(doc);
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
		// Remove non-breaking space characters (both HTML entity form and actual Unicode U+00A0)
		tikzSource = tikzSource.replace(/ /g, ' ').replaceAll("&nbsp;", ' ');

		let lines = tikzSource.split("\n");

		// Trim whitespace that is inserted when pasting in code, otherwise TikZJax complains
		lines = lines.map(line => line.trim());

		// Remove empty lines
		lines = lines.filter(line => line);

		return lines.join("\n");
	}


	colorSVGinDarkMode(svg: string) {
		// Replace black/white color values in both direct SVG attributes and inline style blocks.
		const bgColor = 'var(--background-primary)';

		const blackPatterns = ['#000000', '#000', 'black', 'rgb\\(0,\\s*0,\\s*0\\)'];
		const whitePatterns = ['#ffffff', '#fff', 'white', 'rgb\\(255,\\s*255,\\s*255\\)'];
		const colorAttrs = ['fill', 'stroke', 'color'];

		const replaceColorAttrs = (input: string, patterns: string[], replacement: string): string => {
			let out = input;
			for (const attr of colorAttrs) {
				for (const pattern of patterns) {
					out = out.replace(new RegExp(`${attr}="${pattern}"`, 'gi'), `${attr}="${replacement}"`);
					out = out.replace(new RegExp(`${attr}='${pattern}'`, 'gi'), `${attr}="${replacement}"`);
				}
			}
			return out;
		};

		const replaceInlineStyleColors = (input: string, patterns: string[], replacement: string): string => {
			let out = input;
			for (const attr of colorAttrs) {
				for (const pattern of patterns) {
					out = out.replace(
						new RegExp(`(${attr}\\s*:\\s*)${pattern}(\\s*;?)`, 'gi'),
						`$1${replacement}$2`
					);
				}
			}
			return out;
		};

		svg = replaceColorAttrs(svg, blackPatterns, 'currentColor');
		svg = replaceColorAttrs(svg, whitePatterns, bgColor);
		svg = replaceInlineStyleColors(svg, blackPatterns, 'currentColor');
		svg = replaceInlineStyleColors(svg, whitePatterns, bgColor);

		// TikZJax text often relies on SVG's default black fill (no explicit fill attr).
		// In dark mode, make those text nodes inherit the foreground color.
		svg = svg.replace(/<text\b([^>]*)>/gi, (fullTag, attrs) => {
			if (/\/\s*>$/.test(fullTag)) { return fullTag; }
			if (/\bfill\s*=\s*(['"]).*?\1/i.test(attrs)) { return fullTag; }
			if (/\bcolor\s*=\s*(['"]).*?\1/i.test(attrs)) { return fullTag; }
			if (/\bstyle\s*=\s*(['"])[\s\S]*?\bfill\s*:/i.test(attrs)) { return fullTag; }
			if (/\bstyle\s*=\s*(['"])[\s\S]*?\bcolor\s*:/i.test(attrs)) { return fullTag; }
			return fullTag.replace(/>$/, ' fill="currentColor">');
		});

		return svg;
	}


	optimizeSVG(svg: string) {
		// Optimize the SVG using SVGO
		// Fixes misaligned text nodes on mobile
		// @ts-ignore — svgo.browser return type doesn't expose .data in TS defs
		return optimize(svg, { plugins: [
			{
				name: 'preset-default',
				params: {
					overrides: {
						// Preserve IDs to avoid conflicts with multiple diagrams
						cleanupIDs: false,
						// Preserve viewBox for proper scaling
						removeViewBox: false,
						// Disable path optimizations that cause uneven stroke widths
						// and jagged curves (empirically verified)
						convertPathData: false,
						mergePaths: false,
						convertTransform: false,
						convertShapeToPath: false,
					}
				}
			}
		// @ts-ignore
		]}).data;
	}

	/**
	 * Fix SVG width/height to match the viewBox dimensions exactly.
	 * tikzjax outputs width/height ~1.333x the viewBox (72/54 dpi ratio),
	 * causing stroke widths to render at fractional CSS pixels (e.g. 0.8→1.067),
	 * producing uneven borders and jagged curves.
	 */
	fixSvgDimensions(svg: string): string {
		const viewBoxMatch = svg.match(/viewBox="([^"]+)"/);
		if (!viewBoxMatch) { return svg; }

		const parts = viewBoxMatch[1].trim().split(/\s+/);
		if (parts.length !== 4) { return svg; }

		const vbWidth = parts[2];
		const vbHeight = parts[3];

		let result = svg.replace(/(<svg[^>]*?\s)width="[^"]*"/, `$1width="${vbWidth}pt"`);
		result = result.replace(/(<svg[^>]*?\s)height="[^"]*"/, `$1height="${vbHeight}pt"`);
		return result;
	}


	postProcessSvg = (e: Event) => {

		const svgEl = e.target as HTMLElement;
		const container = svgEl.closest('[data-tikz-source]') as HTMLElement | null;
		let svg = svgEl.outerHTML;

		svg = this.fixSvgDimensions(svg);

		if (this.settings.invertColorsInDarkMode) {
			svg = this.colorSVGinDarkMode(svg);
		}

		svg = this.optimizeSVG(svg);

		svgEl.outerHTML = svg;

		// Cache the processed SVG so future renders (e.g. PDF export) can
		// reuse it immediately without waiting for the tikzjax Worker.
		const source = container?.dataset.tikzSource;
		if (source) {
			this.svgCache.set(source, svg);
		}
	}
}
