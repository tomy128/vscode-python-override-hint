import * as vscode from 'vscode';
import * as path from 'path';
import { spawn, ChildProcess } from 'child_process';
import * as cp from 'child_process';
import * as fs from 'fs';

// 全局变量
let outputChannel: vscode.OutputChannel;

/**
 * Override 信息接口
 */
interface OverrideInfo {
    class: string;
    method: string;
    line: number;
    signature?: string;
    type: 'child_override' | 'parent_overridden';
    
    // 父类信息
    base?: string;
    base_file?: string;
    base_file_path?: string;
    base_line?: number;
    base_signature?: string;
    
    // 子类信息
    child?: string;
    child_file?: string;
    child_file_path?: string;
    child_line?: number;
    child_signature?: string;
}

/**
 * 项目索引接口
 */
interface ProjectIndex {
    files: Map<string, { overrides: OverrideInfo[], lastModified: number }>;
    dependencies: Map<string, string[]>; // 文件依赖关系
    lastScan: number;
}

/**
 * Python进程管理器 - 维护持久化的Python分析器进程
 */
class PythonProcessManager {
    private pythonProcess: ChildProcess | null = null;
    private messageId = 0;
    private pendingRequests = new Map<string, { resolve: Function; reject: Function; timeout?: NodeJS.Timeout }>();
    private isReady = false;
    private readyPromise: Promise<void>;
    private readyResolve?: Function;
    private outputBuffer = '';

    constructor(private pythonPath: string, private scriptPath: string, private workspaceRoot: string) {
        this.readyPromise = new Promise((resolve) => {
            this.readyResolve = resolve;
        });
    }

    async start(): Promise<void> {
        if (this.pythonProcess) {
            outputChannel.appendLine('Python process already running, returning existing promise');
            return this.readyPromise;
        }

        try {
            outputChannel.appendLine(`Starting Python process: ${this.pythonPath} ${this.scriptPath} --server ${this.workspaceRoot}`);
            this.pythonProcess = spawn(this.pythonPath, [this.scriptPath, '--server', this.workspaceRoot], {
                cwd: this.workspaceRoot,
                stdio: ['pipe', 'pipe', 'pipe']
            });

            outputChannel.appendLine(`Python process spawned with PID: ${this.pythonProcess.pid}`);
            this.setupProcessHandlers();
            outputChannel.appendLine('Process handlers set up, waiting for ready signal...');
            return this.readyPromise;
        } catch (error: any) {
            outputChannel.appendLine(`Failed to start Python process: ${error.message}`);
            outputChannel.appendLine(`Error stack: ${error.stack}`);
            throw error;
        }
    }

    private setupProcessHandlers(): void {
        if (!this.pythonProcess) return;

        outputChannel.appendLine('Setting up Python process handlers...');

        this.pythonProcess.stdout?.on('data', (data: Buffer) => {
            const output = data.toString();
            outputChannel.appendLine(`Python stdout: ${output}`);
            this.outputBuffer += output;
            this.processOutput();
        });

        this.pythonProcess.stderr?.on('data', (data: Buffer) => {
            outputChannel.appendLine(`Python stderr: ${data.toString()}`);
        });

        this.pythonProcess.on('error', (error: any) => {
            outputChannel.appendLine(`Python process error: ${error.message}`);
            this.cleanup();
        });

        this.pythonProcess.on('exit', (code: any) => {
            outputChannel.appendLine(`Python process exited with code: ${code}`);
            this.cleanup();
        });

        outputChannel.appendLine('Python process handlers set up successfully');
    }

    private processOutput(): void {
        const lines = this.outputBuffer.split('\n');
        this.outputBuffer = lines.pop() || '';

        for (const line of lines) {
            if (line.trim()) {
                outputChannel.appendLine(`Processing line: ${line}`);
                try {
                    const response = JSON.parse(line);
                    outputChannel.appendLine(`Parsed response: ${JSON.stringify(response)}`);
                    if (response.type === 'ready') {
                        outputChannel.appendLine('Received ready signal from Python process');
                        this.isReady = true;
                        this.readyResolve?.();
                    } else {
                        this.handleResponse(response);
                    }
                } catch (error: any) {
                    outputChannel.appendLine(`Failed to parse response: ${line}, error: ${error.message}`);
                }
            }
        }
    }

    private handleResponse(response: any): void {
        const requestId = response.id;
        const request = this.pendingRequests.get(requestId);
        
        if (request) {
            if (request.timeout) {
                clearTimeout(request.timeout);
            }
            this.pendingRequests.delete(requestId);
            
            if (response.error) {
                request.reject(new Error(response.error));
            } else {
                request.resolve(response.result || []);
            }
        }
    }

    async analyzeFile(filePath: string, timeoutMs: number = 10000): Promise<any[]> {
        if (!this.isReady) {
            await this.readyPromise;
        }

        return new Promise((resolve, reject) => {
            const id = `req_${++this.messageId}`;
            const request = {
                id,
                command: 'analyze',
                data: { file_path: filePath }
            };

            const timeout = setTimeout(() => {
                this.pendingRequests.delete(id);
                reject(new Error(`Analysis timeout for ${filePath}`));
            }, timeoutMs);

            this.pendingRequests.set(id, { resolve, reject, timeout });

            try {
                outputChannel.appendLine(`Sending request: ${JSON.stringify(request)}`);
                this.pythonProcess?.stdin?.write(JSON.stringify(request) + '\n');
            } catch (error: any) {
                this.pendingRequests.delete(id);
                clearTimeout(timeout);
                reject(error);
            }
        });
    }

    private cleanup(): void {
        this.isReady = false;
        this.pythonProcess = null;
        
        // 拒绝所有待处理的请求
        for (const [id, request] of this.pendingRequests) {
            if (request.timeout) {
                clearTimeout(request.timeout);
            }
            request.reject(new Error('Python process terminated'));
        }
        this.pendingRequests.clear();
    }

    async restart(): Promise<void> {
        this.dispose();
        await new Promise(resolve => setTimeout(resolve, 1000)); // 等待清理完成
        await this.start();
    }

    dispose(): void {
        if (this.pythonProcess) {
            this.pythonProcess.kill();
            this.pythonProcess = null;
        }
        this.cleanup();
    }
}

/**
 * 智能缓存管理器 - 支持文件系统监听和智能失效
 */
class IntelligentCache {
    private projectIndex: ProjectIndex = {
        files: new Map(),
        dependencies: new Map(),
        lastScan: 0
    };
    private workspaceWatcher: vscode.FileSystemWatcher | null = null;

    constructor(private context: vscode.ExtensionContext) {
        this.loadCache();
        this.setupFileWatcher();
    }

    // 新增：设置依赖关系
    setDependencies(filePath: string, deps: string[]): void {
        const unique = Array.from(new Set(deps.filter(Boolean)));
        this.projectIndex.dependencies.set(filePath, unique);
        this.persistCache();
    }

    private setupFileWatcher(): void {
        // 监听Python文件变化
        this.workspaceWatcher = vscode.workspace.createFileSystemWatcher('**/*.py');
        
        this.workspaceWatcher.onDidChange((uri) => {
            this.invalidateFile(uri.fsPath);
        });
        
        this.workspaceWatcher.onDidDelete((uri) => {
            this.removeFile(uri.fsPath);
        });
    }

    private loadCache(): void {
        try {
            const cacheFile = path.join(this.context.globalStorageUri.fsPath, 'override_cache.json');
            if (fs.existsSync(cacheFile)) {
                const data = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
                this.projectIndex = {
                    files: new Map(data.files || []),
                    dependencies: new Map(data.dependencies || []),
                    lastScan: data.lastScan || 0
                };
            }
        } catch (error: any) {
            outputChannel.appendLine(`Failed to load cache: ${error.message}`);
        }
    }

    private persistCache(): void {
        try {
            const cacheFile = path.join(this.context.globalStorageUri.fsPath, 'override_cache.json');
            const dir = path.dirname(cacheFile);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
            
            const data = {
                files: Array.from(this.projectIndex.files.entries()),
                dependencies: Array.from(this.projectIndex.dependencies.entries()),
                lastScan: this.projectIndex.lastScan
            };
            fs.writeFileSync(cacheFile, JSON.stringify(data));
        } catch (error: any) {
            outputChannel.appendLine(`Failed to persist cache: ${error.message}`);
        }
    }

    get(filePath: string): OverrideInfo[] | null {
        const cached = this.projectIndex.files.get(filePath);
        if (!cached) return null;

        // 检查文件是否被修改
        try {
            const stat = fs.statSync(filePath);
            if (stat.mtimeMs > cached.lastModified) {
                this.projectIndex.files.delete(filePath);
                return null;
            }
            return cached.overrides;
        } catch (error: any) {
            this.projectIndex.files.delete(filePath);
            return null;
        }
    }

    set(filePath: string, overrides: OverrideInfo[]): void {
        try {
            const stat = fs.statSync(filePath);
            this.projectIndex.files.set(filePath, {
                overrides,
                lastModified: stat.mtimeMs
            });
            this.persistCache();
        } catch (error: any) {
            // 文件不存在，忽略
        }
    }

    private invalidateFile(filePath: string): void {
        this.projectIndex.files.delete(filePath);
        // 同时失效依赖此文件的其他文件
        const dependents = this.findDependents(filePath);
        dependents.forEach(dep => this.projectIndex.files.delete(dep));
        this.persistCache();
    }

    private removeFile(filePath: string): void {
        this.projectIndex.files.delete(filePath);
        this.projectIndex.dependencies.delete(filePath);
        this.persistCache();
    }

    private findDependents(filePath: string): string[] {
        const dependents: string[] = [];
        for (const [file, deps] of this.projectIndex.dependencies) {
            if (deps.includes(filePath)) {
                dependents.push(file);
            }
        }
        return dependents;
    }

    dispose(): void {
        this.workspaceWatcher?.dispose();
        this.persistCache();
    }

    // 添加缺少的方法
    delete(filePath: string): void {
        this.projectIndex.files.delete(filePath);
        this.persistCache();
    }

    clear(): void {
        this.projectIndex.files.clear();
        this.projectIndex.dependencies.clear();
        this.persistCache();
    }
}

/**
 * Python Override Hint 分析器
 */
class PythonOverrideAnalyzer {
    private processManager: PythonProcessManager | null = null;
    private cache: IntelligentCache;
    private isInitialized = false;

    constructor(private context: vscode.ExtensionContext, private workspaceRoot: string) {
        this.cache = new IntelligentCache(context);
    }

    async initialize(): Promise<void> {
        if (this.isInitialized) return;

        try {
            outputChannel.appendLine('Finding Python path...');
            const pythonPath = await this.findPythonPath();
            outputChannel.appendLine(`Python path found: ${pythonPath}`);
            
            const scriptPath = path.join(__dirname, '..', 'python', 'analyze_override.py');
            outputChannel.appendLine(`Script path: ${scriptPath}`);
            
            // 检查脚本文件是否存在
            if (!fs.existsSync(scriptPath)) {
                throw new Error(`Python script not found at: ${scriptPath}`);
            }
            
            outputChannel.appendLine('Starting Python process manager...');
            this.processManager = new PythonProcessManager(pythonPath, scriptPath, this.workspaceRoot);
            await this.processManager.start();
            
            this.isInitialized = true;
            outputChannel.appendLine('Python Override Analyzer initialized successfully');
        } catch (error: any) {
            outputChannel.appendLine(`Failed to initialize analyzer: ${error.message}`);
            throw error;
        }
    }

    async analyzeFile(filePath: string): Promise<OverrideInfo[]> {
        const cached = this.cache.get(filePath);
        if (cached) {
            return cached;
        }

        if (!this.isInitialized) {
            await this.initialize();
        }

        try {
            const result = await this.processManager!.analyzeFile(filePath);
            const raw: any[] = result || [];
            // 归一化字段（Python 使用 class_name）
            const overrides: OverrideInfo[] = raw.map(r => ({
                class: r.class ?? r.class_name ?? '',
                method: r.method,
                line: r.line,
                signature: r.signature,
                type: r.type,
                base: r.base,
                base_file: r.base_file,
                base_file_path: r.base_file_path,
                base_line: r.base_line,
                base_signature: r.base_signature,
                child: r.child,
                child_file: r.child_file,
                child_file_path: r.child_file_path,
                child_line: r.child_line,
                child_signature: r.child_signature,
            }));
            
            // 缓存结果
            this.cache.set(filePath, overrides);
            // 记录跨文件依赖（用于智能失效）
            const deps: string[] = [];
            for (const o of overrides) {
                if (o.type === 'child_override' && o.base_file_path) deps.push(o.base_file_path);
                if (o.type === 'parent_overridden' && o.child_file_path) deps.push(o.child_file_path);
            }
            this.cache.setDependencies(filePath, deps);
            
            return overrides;
        } catch (error: any) {
            outputChannel.appendLine(`Analysis failed for ${filePath}: ${error.message}`);
            if (this.processManager) {
                try { await this.processManager.restart(); } catch {}
            }
            return [];
        }
    }

    private async findPythonPath(): Promise<string> {
        // 1. 尝试从VS Code Python扩展获取
        const pythonExtension = vscode.extensions.getExtension('ms-python.python');
        if (pythonExtension?.isActive) {
            try {
                const pythonApi = pythonExtension.exports;
                if (pythonApi?.settings?.getExecutionDetails) {
                    const details = pythonApi.settings.getExecutionDetails();
                    if (details?.execCommand?.[0]) {
                        return details.execCommand[0];
                    }
                }
            } catch (error: any) {
                outputChannel.appendLine(`Failed to get Python path from extension: ${error.message}`);
            }
        }

        // 2. 尝试从配置获取
        const config = vscode.workspace.getConfiguration('python');
        const pythonPath = config.get<string>('pythonPath') || config.get<string>('defaultInterpreterPath');
        if (pythonPath) {
            return pythonPath;
        }

        // 3. 使用系统默认
        return process.platform === 'win32' ? 'python' : 'python3';
    }

    clearCache(filePath?: string): void {
        if (filePath) {
            this.cache.delete(filePath);
        } else {
            this.cache.clear();
        }
    }

    dispose(): void {
        this.processManager?.dispose();
        this.cache.dispose();
    }
}

/**
 * Override 装饰器提供者
 */
class OverrideDecorationProvider {
    private childOverrideDecorationType: vscode.TextEditorDecorationType;
    private parentOverriddenDecorationType: vscode.TextEditorDecorationType;
    private bothDecorationType: vscode.TextEditorDecorationType;
    private analyzer: PythonOverrideAnalyzer;

    constructor(context: vscode.ExtensionContext, analyzer: PythonOverrideAnalyzer) {
        this.analyzer = analyzer;
        
        // 子类重写父类方法的装饰器（向上箭头）
        this.childOverrideDecorationType = vscode.window.createTextEditorDecorationType({
            gutterIconPath: vscode.Uri.file(path.join(context.extensionPath, 'resources', 'override-up.svg')),
            gutterIconSize: 'contain',
            overviewRulerColor: '#4CAF50',
            overviewRulerLane: vscode.OverviewRulerLane.Right,
            rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed
        });

        // 父类被子类重写方法的装饰器（向下箭头）
        this.parentOverriddenDecorationType = vscode.window.createTextEditorDecorationType({
            gutterIconPath: vscode.Uri.file(path.join(context.extensionPath, 'resources', 'override-down.svg')),
            gutterIconSize: 'contain',
            overviewRulerColor: '#FF9800',
            overviewRulerLane: vscode.OverviewRulerLane.Right,
            rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed
        });

        // 同一行同时存在两种关系时使用合成图标（同时显示上/下箭头）
        this.bothDecorationType = vscode.window.createTextEditorDecorationType({
            gutterIconPath: vscode.Uri.file(path.join(context.extensionPath, 'resources', 'override-both.svg')),
            gutterIconSize: 'contain',
            overviewRulerColor: '#9C27B0',
            overviewRulerLane: vscode.OverviewRulerLane.Right,
            rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed
        });
    }

    private findClassLine(editor: vscode.TextEditor, className: string): number | null {
        const regex = new RegExp(`^\\s*class\\s+${className}\\b`);
        for (let i = 0; i < editor.document.lineCount; i++) {
            const text = editor.document.lineAt(i).text;
            if (regex.test(text)) {
                return i;
            }
        }
        return null;
    }

    async updateDecorations(editor: vscode.TextEditor): Promise<void> {
        if (!editor || editor.document.languageId !== 'python') {
            return;
        }

        try {
            const overrides = await this.analyzer.analyzeFile(editor.document.fileName);
            
            const childOverrideDecorations: vscode.DecorationOptions[] = [];
            const parentOverriddenDecorations: vscode.DecorationOptions[] = [];
            const bothDecorations: vscode.DecorationOptions[] = [];

            // 先按行聚合类型（方法级）
            const lineMap = new Map<number, { child?: vscode.DecorationOptions; parent?: vscode.DecorationOptions }>();
            // 按类聚合（类级）
            const classMap = new Map<string, { child: boolean; parent: boolean }>();

            for (const override of overrides) {
                const line = override.line - 1; // VS Code uses 0-based line numbers
                if (line >= 0 && line < editor.document.lineCount) {
                    const range = new vscode.Range(line, 0, line, 0);
                    const decoration: vscode.DecorationOptions = {
                        range,
                        hoverMessage: this.createHoverMessage(override)
                    };

                    const entry = lineMap.get(line) || {};
                    if (override.type === 'child_override') {
                        entry.child = decoration;
                    } else if (override.type === 'parent_overridden') {
                        entry.parent = decoration;
                    }
                    lineMap.set(line, entry);
                }

                // 类聚合标记
                const info = classMap.get(override.class) || { child: false, parent: false };
                if (override.type === 'child_override') info.child = true;
                if (override.type === 'parent_overridden') info.parent = true;
                classMap.set(override.class, info);
            }

            // 方法级分配装饰
            for (const [line, types] of lineMap.entries()) {
                if (types.child && types.parent) {
                    bothDecorations.push(types.child);
                } else if (types.child) {
                    childOverrideDecorations.push(types.child);
                } else if (types.parent) {
                    parentOverriddenDecorations.push(types.parent);
                }
            }

            // 类级分配装饰（在类定义行放置图标）
            for (const [className, flags] of classMap.entries()) {
                const classLine = this.findClassLine(editor, className);
                if (classLine !== null) {
                    const range = new vscode.Range(classLine, 0, classLine, 0);
                    const decoration: vscode.DecorationOptions = { range };
                    if (flags.child && flags.parent) {
                        bothDecorations.push(decoration);
                    } else if (flags.child) {
                        childOverrideDecorations.push(decoration);
                    } else if (flags.parent) {
                        parentOverriddenDecorations.push(decoration);
                    }
                }
            }

            // 应用装饰
            editor.setDecorations(this.childOverrideDecorationType, childOverrideDecorations);
            editor.setDecorations(this.parentOverriddenDecorationType, parentOverriddenDecorations);
            editor.setDecorations(this.bothDecorationType, bothDecorations);
            
            outputChannel.appendLine(`Decorations applied: method(up=${childOverrideDecorations.length}, down=${parentOverriddenDecorations.length}), both=${bothDecorations.length}; classes=${classMap.size}`);
        } catch (error: any) {
            outputChannel.appendLine(`Failed to update decorations: ${error.message}`);
        }
    }

    private createHoverMessage(override: OverrideInfo): vscode.MarkdownString {
        const message = new vscode.MarkdownString();
        message.isTrusted = true;

        if (override.type === 'child_override') {
            message.appendMarkdown(`**Override Method** 🔼\n\n`);
            message.appendMarkdown(`**Method:** \`${override.method}\`\n\n`);
            message.appendMarkdown(`**Class:** \`${override.class}\`\n\n`);
            
            if (override.base && override.base_file) {
                const baseFileUri = vscode.Uri.file(override.base_file_path || override.base_file);
                const baseLocation = override.base_line ? `#${override.base_line}` : '';
                message.appendMarkdown(`**Overrides:** \`${override.base}\` in [${override.base_file}](${baseFileUri}${baseLocation})\n\n`);
                
                if (override.base_signature) {
                    message.appendMarkdown(`**Base Signature:** \`${override.base_signature}\`\n\n`);
                }
            }
            
            if (override.signature) {
                message.appendMarkdown(`**Current Signature:** \`${override.signature}\`\n\n`);
            }
        } else if (override.type === 'parent_overridden') {
            message.appendMarkdown(`**Overridden Method** 🔽\n\n`);
            message.appendMarkdown(`**Method:** \`${override.method}\`\n\n`);
            message.appendMarkdown(`**Class:** \`${override.class}\`\n\n`);
            
            if (override.child && override.child_file) {
                const childFileUri = vscode.Uri.file(override.child_file_path || override.child_file);
                const childLocation = override.child_line ? `#${override.child_line}` : '';
                message.appendMarkdown(`**Overridden by:** \`${override.child}\` in [${override.child_file}](${childFileUri}${childLocation})\n\n`);
                
                if (override.child_signature) {
                    message.appendMarkdown(`**Child Signature:** \`${override.child_signature}\`\n\n`);
                }
            }
            
            if (override.signature) {
                message.appendMarkdown(`**Current Signature:** \`${override.signature}\`\n\n`);
            }
        }

        return message;
    }

    dispose(): void {
        this.childOverrideDecorationType.dispose();
        this.parentOverriddenDecorationType.dispose();
        this.bothDecorationType.dispose();
    }
}

/**
 * Override CodeLens 提供者
 */
class OverrideCodeLensProvider implements vscode.CodeLensProvider {
    private analyzer: PythonOverrideAnalyzer;
    private _onDidChangeCodeLenses = new vscode.EventEmitter<void>();
    public readonly onDidChangeCodeLenses = this._onDidChangeCodeLenses.event;

    constructor(analyzer: PythonOverrideAnalyzer) {
        this.analyzer = analyzer;
    }

    private findClassLine(document: vscode.TextDocument, className: string): number | null {
        const regex = new RegExp(`^\\s*class\\s+${className}\\b`);
        for (let i = 0; i < document.lineCount; i++) {
            const text = document.lineAt(i).text;
            if (regex.test(text)) {
                return i;
            }
        }
        return null;
    }

    async provideCodeLenses(document: vscode.TextDocument): Promise<vscode.CodeLens[]> {
        if (document.languageId !== 'python') {
            return [];
        }

        try {
            const overrides = await this.analyzer.analyzeFile(document.fileName);
            const codeLenses: vscode.CodeLens[] = [];

            // 读取设置项
            const config = vscode.workspace.getConfiguration('PythonOverrideHint');
            const classLensEnabled = config.get<boolean>('classCodeLens.enabled', true);
            const classLensStyle = config.get<string>('classCodeLens.style', 'summary');

            // 方法级 CodeLens（现有逻辑）
            for (const override of overrides) {
                const line = override.line - 1;
                if (line >= 0 && line < document.lineCount) {
                    const range = new vscode.Range(line, 0, line, 0);
                    if (override.type === 'child_override' && override.base_file_path) {
                        const codeLens = new vscode.CodeLens(range, {
                            title: `↑ Go to base: ${override.base}`,
                            command: 'vscode.open',
                            arguments: [
                                vscode.Uri.file(override.base_file_path!),
                                { selection: new vscode.Range(override.base_line! - 1, 0, override.base_line! - 1, 0) }
                            ]
                        });
                        codeLenses.push(codeLens);
                    } else if (override.type === 'parent_overridden' && override.child_file_path) {
                        const codeLens = new vscode.CodeLens(range, {
                            title: `↓ Go to override: ${override.child}`,
                            command: 'vscode.open',
                            arguments: [
                                vscode.Uri.file(override.child_file_path!),
                                { selection: new vscode.Range(override.child_line! - 1, 0, override.child_line! - 1, 0) }
                            ]
                        });
                        codeLenses.push(codeLens);
                    }
                }
            }

            // 类级 CodeLens（根据设置控制显示与样式）
            if (classLensEnabled) {
                const byClassDetail = new Map<string, { bases: Map<string, { name: string; path: string; line: number }>; children: Map<string, { name: string; path: string; line: number }> }>();
                for (const o of overrides) {
                    const entry = byClassDetail.get(o.class) || { bases: new Map(), children: new Map() };
                    if (o.type === 'child_override' && o.base && o.base_file_path && o.base_line) {
                        entry.bases.set(o.base, { name: o.base, path: o.base_file_path, line: o.base_line });
                    }
                    if (o.type === 'parent_overridden' && o.child && o.child_file_path && o.child_line) {
                        entry.children.set(o.child, { name: o.child, path: o.child_file_path, line: o.child_line });
                    }
                    byClassDetail.set(o.class, entry);
                }

                for (const [className, detail] of byClassDetail.entries()) {
                    const classLine = this.findClassLine(document, className);
                    if (classLine !== null) {
                        const range = new vscode.Range(classLine, 0, classLine, 0);
                        if (detail.bases.size > 0) {
                            const items = Array.from(detail.bases.values()).map(b => ({ label: b.name, detail: b.path, path: b.path, line: b.line }));
                            if (classLensStyle === 'summary') {
                                const lens = new vscode.CodeLens(range, {
                                    title: `↑ Base: ${detail.bases.size} 父类`,
                                    command: 'pythonOverrideHint.quickPickRelations',
                                    arguments: [items]
                                });
                                codeLenses.push(lens);
                            } else {
                                const names = Array.from(detail.bases.values()).map(b => b.name).join(', ');
                                const lens = new vscode.CodeLens(range, {
                                    title: `↑ Base: ${names}`,
                                    command: 'pythonOverrideHint.quickPickRelations',
                                    arguments: [items]
                                });
                                codeLenses.push(lens);
                            }
                        }
                        if (detail.children.size > 0) {
                            const items = Array.from(detail.children.values()).map(c => ({ label: c.name, detail: c.path, path: c.path, line: c.line }));
                            if (classLensStyle === 'summary') {
                                const lens = new vscode.CodeLens(range, {
                                    title: `↓ Overridden by: ${detail.children.size} 子类`,
                                    command: 'pythonOverrideHint.quickPickRelations',
                                    arguments: [items]
                                });
                                codeLenses.push(lens);
                            } else {
                                const names = Array.from(detail.children.values()).map(c => c.name).join(', ');
                                const lens = new vscode.CodeLens(range, {
                                    title: `↓ Overridden by: ${names}`,
                                    command: 'pythonOverrideHint.quickPickRelations',
                                    arguments: [items]
                                });
                                codeLenses.push(lens);
                            }
                        }
                    }
                }
            }

            return codeLenses;
        } catch (error: any) {
            outputChannel.appendLine(`Failed to provide code lenses: ${error.message}`);
            return [];
        }
    }

    refresh(): void {
        this._onDidChangeCodeLenses.fire();
    }
}

/**
 * 文档管理器
 */
class DocumentManager {
    private analyzer: PythonOverrideAnalyzer;
    private decorationProvider: OverrideDecorationProvider;
    private codeLensProvider: OverrideCodeLensProvider;
    private disposables: vscode.Disposable[] = [];
    private analysisQueue = new Map<string, NodeJS.Timeout>();
    private statusBarItem: vscode.StatusBarItem;

    constructor(context: vscode.ExtensionContext, workspaceRoot: string) {
        this.analyzer = new PythonOverrideAnalyzer(context, workspaceRoot);
        this.decorationProvider = new OverrideDecorationProvider(context, this.analyzer);
        this.codeLensProvider = new OverrideCodeLensProvider(this.analyzer);
        
        // 创建状态栏项
        this.statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
        this.statusBarItem.show();
        
        this.setupEventListeners();
        // 不在构造函数中调用异步方法
    }

    // 新增初始化方法
    async initialize(): Promise<void> {
        await this.preloadAnalyzer();
    }

    private async preloadAnalyzer(): Promise<void> {
        try {
            outputChannel.appendLine('Starting Python analyzer initialization...');
            this.updateStatus('$(loading~spin) Initializing Python analyzer...', 'Python Override Hint is starting up');
            await this.analyzer.initialize();
            this.updateStatus('$(check) Python analyzer ready', 'Python Override Hint is ready');
            outputChannel.appendLine('Python analyzer initialized successfully');
            
            // 3秒后隐藏状态
            setTimeout(() => {
                this.statusBarItem.hide();
            }, 3000);
        } catch (error: any) {
            const errorMsg = `Failed to initialize Python analyzer: ${error.message}`;
            outputChannel.appendLine(errorMsg);
            outputChannel.appendLine(`Error stack: ${error.stack}`);
            this.updateStatus('$(error) Analyzer failed', `Failed to initialize: ${error.message}`);
            throw error; // 重新抛出错误以便上层处理
        }
    }

    private updateStatus(text: string, tooltip: string): void {
        this.statusBarItem.text = text;
        this.statusBarItem.tooltip = tooltip;
    }

    private setupEventListeners(): void {
        // 文档打开事件
        this.disposables.push(vscode.workspace.onDidOpenTextDocument((document) => {
            if (document.languageId === 'python') {
                this.scheduleAnalysis(document.fileName, 100);
            }
        }));

        // 活动编辑器变化事件
        this.disposables.push(vscode.window.onDidChangeActiveTextEditor((editor) => {
            if (editor?.document.languageId === 'python') {
                this.scheduleAnalysis(editor.document.fileName, 50);
            }
        }));

        // 文档保存事件
        this.disposables.push(vscode.workspace.onDidSaveTextDocument((document) => {
            if (document.languageId === 'python') {
                this.analyzer.clearCache(document.fileName);
                this.scheduleAnalysis(document.fileName, 200);
            }
        }));

        // 文档变更事件（防抖）
        this.disposables.push(vscode.workspace.onDidChangeTextDocument((event) => {
            if (event.document.languageId === 'python') {
                this.scheduleAnalysis(event.document.fileName, 1000);
            }
        }));

        // 注册CodeLens提供者
        this.disposables.push(vscode.languages.registerCodeLensProvider(
            { language: 'python' },
            this.codeLensProvider
        ));

        // 监听配置变化，刷新 CodeLens
        this.disposables.push(vscode.workspace.onDidChangeConfiguration((e) => {
            if (e.affectsConfiguration('PythonOverrideHint.classCodeLens')) {
                this.codeLensProvider.refresh();
            }
        }));
    }

    private scheduleAnalysis(filePath: string, delay: number): void {
        // 取消之前的分析任务
        const existingTimeout = this.analysisQueue.get(filePath);
        if (existingTimeout) {
            clearTimeout(existingTimeout);
        }

        // 调度新的分析任务
        const timeout = setTimeout(() => {
            this.performAnalysis(filePath);
            this.analysisQueue.delete(filePath);
        }, delay);

        this.analysisQueue.set(filePath, timeout);
    }

    private async performAnalysis(filePath: string): Promise<void> {
        try {
            const editor = vscode.window.activeTextEditor;
            if (editor && editor.document.fileName === filePath) {
                this.updateStatus('$(loading~spin) Analyzing...', 'Analyzing Python overrides');
                await this.decorationProvider.updateDecorations(editor);
                this.codeLensProvider.refresh();
                this.updateStatus('$(check) Analysis complete', 'Python override analysis complete');
                
                // 2秒后隐藏状态
                setTimeout(() => {
                    this.statusBarItem.hide();
                }, 2000);
            }
        } catch (error: any) {
            outputChannel.appendLine(`Analysis failed for ${filePath}: ${error.message}`);
            this.updateStatus('$(error) Analysis failed', `Analysis failed: ${error.message}`);
        }
    }

    async refreshAnalysis(filePath: string): Promise<void> {
        this.analyzer.clearCache(filePath);
        await this.performAnalysis(filePath);
    }

    dispose(): void {
        // 清理所有超时任务
        for (const timeout of this.analysisQueue.values()) {
            clearTimeout(timeout);
        }
        this.analysisQueue.clear();

        // 清理所有订阅
        this.disposables.forEach(d => d.dispose());
        this.disposables = [];

        // 清理组件
        this.analyzer.dispose();
        this.decorationProvider.dispose();
        this.statusBarItem.dispose();
    }
}

/**
 * 扩展激活函数
 */
export async function activate(context: vscode.ExtensionContext) {
    outputChannel = vscode.window.createOutputChannel('Python Override Hint');
    try {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        const workspaceRoot = workspaceFolders && workspaceFolders.length > 0
            ? workspaceFolders[0].uri.fsPath
            : vscode.workspace.rootPath || '';
        outputChannel.appendLine(`Workspace root: ${workspaceRoot}`);

        // 初始化文档管理器
        outputChannel.appendLine('Creating DocumentManager...');
        const documentManager = new DocumentManager(context, workspaceRoot);
        outputChannel.appendLine('Initializing DocumentManager...');
        await documentManager.initialize();

        // 注册刷新命令
        outputChannel.appendLine('Registering refresh command...');
        const refreshCommand = vscode.commands.registerCommand('pythonOverrideHint.refresh', async () => {
            const activeEditor = vscode.window.activeTextEditor;
            if (activeEditor && activeEditor.document.languageId === 'python') {
                await documentManager.refreshAnalysis(activeEditor.document.fileName);
            }
        });

        // 新增：注册 QuickPick 命令
        const quickPickCommand = vscode.commands.registerCommand('pythonOverrideHint.quickPickRelations', async (items: Array<{ label: string; detail?: string; path: string; line: number }>) => {
            const pick = await vscode.window.showQuickPick(items.map(i => ({ label: i.label, detail: i.detail })), { placeHolder: '选择以跳转' });
            if (!pick) return;
            const matched = items.find(i => i.label === pick.label && i.detail === pick.detail);
            if (matched) {
                await vscode.window.showTextDocument(vscode.Uri.file(matched.path), { selection: new vscode.Range(matched.line - 1, 0, matched.line - 1, 0) });
            }
        });

        context.subscriptions.push(refreshCommand, quickPickCommand, documentManager);
        outputChannel.appendLine('Python Override Hint extension activated successfully');

    } catch (error: any) {
        const errorMsg = `Failed to activate extension: ${error.message}`;
        outputChannel.appendLine(errorMsg);
        outputChannel.appendLine(`Error stack: ${error.stack}`);
        vscode.window.showErrorMessage(`Python Override Hint activation failed: ${error.message}`);
    }
}

/**
 * 检查Pylance是否已安装
 */
function isPylanceInstalled(): boolean {
    return vscode.extensions.getExtension('ms-python.pylance') !== undefined;
}

/**
 * 扩展停用函数
 */
export function deactivate() {
    outputChannel?.appendLine('Python Override Hint extension is deactivating...');
}