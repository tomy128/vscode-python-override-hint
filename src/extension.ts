import * as vscode from 'vscode';
import * as path from 'path';
import { spawn } from 'child_process';

// 全局输出通道
let outputChannel: vscode.OutputChannel;

/**
 * 重写方法信息接口
 */
interface OverrideInfo {
    class: string;
    method: string;
    line: number;
    signature?: string;
    type: 'child_override' | 'parent_overridden';
    
    // 子类重写父类时的字段
    base?: string;
    base_file?: string;
    base_file_path?: string;
    base_line?: number;
    base_signature?: string;
    
    // 父类被子类重写时的字段
    child?: string;
    child_file?: string;
    child_file_path?: string;
    child_line?: number;
    child_signature?: string;
}

/**
 * 分析结果缓存
 */
class AnalysisCache {
    private cache = new Map<string, { overrides: OverrideInfo[], timestamp: number }>();
    private readonly CACHE_DURATION = 30000; // 30秒缓存

    set(filePath: string, overrides: OverrideInfo[]): void {
        this.cache.set(filePath, {
            overrides,
            timestamp: Date.now()
        });
    }

    get(filePath: string): OverrideInfo[] | null {
        const cached = this.cache.get(filePath);
        if (!cached) {
            return null;
        }

        // 检查缓存是否过期
        if (Date.now() - cached.timestamp > this.CACHE_DURATION) {
            this.cache.delete(filePath);
            return null;
        }

        return cached.overrides;
    }

    clear(): void {
        this.cache.clear();
    }

    delete(filePath: string): void {
        this.cache.delete(filePath);
    }
}

/**
 * Python Override Hint 分析器
 */
class PythonOverrideAnalyzer {
    private cache = new AnalysisCache();
    private pendingAnalysis = new Map<string, Promise<OverrideInfo[]>>();

    constructor(private context: vscode.ExtensionContext) {}

    /**
     * 分析 Python 文件的重写方法
     */
    async analyzeFile(filePath: string): Promise<OverrideInfo[]> {
        // 检查缓存
        const cached = this.cache.get(filePath);
        if (cached) {
            return cached;
        }

        // 检查是否已有正在进行的分析
        const pending = this.pendingAnalysis.get(filePath);
        if (pending) {
            return pending;
        }

        // 开始新的分析
        const analysisPromise = this.runPythonAnalysis(filePath);
        this.pendingAnalysis.set(filePath, analysisPromise);

        try {
            const result = await analysisPromise;
            this.cache.set(filePath, result);
            return result;
        } finally {
            this.pendingAnalysis.delete(filePath);
        }
    }

    /**
     * 运行 Python 分析脚本
     */
    private async runPythonAnalysis(filePath: string): Promise<OverrideInfo[]> {
        return new Promise((resolve, reject) => {
            const config = vscode.workspace.getConfiguration('PythonOverrideHint');
            const pythonPath = config.get<string>('pythonPath', 'python3');
            
            const scriptPath = path.join(this.context.extensionPath, 'python', 'analyze_override.py');
            const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || path.dirname(filePath);
            

            
            const process = spawn(pythonPath, [scriptPath, filePath, workspaceRoot], {
                cwd: workspaceRoot
            });

            let stdout = '';
            let stderr = '';

            process.stdout.on('data', (data: Buffer) => {
                stdout += data.toString();
            });

            process.stderr.on('data', (data: Buffer) => {
                stderr += data.toString();
            });

            process.on('close', (code: number | null) => {
                if (code === 0) {
                    try {
                        const result = JSON.parse(stdout) as OverrideInfo[];
                        outputChannel.appendLine(`分析完成: ${filePath}, 找到 ${result.length} 个重写关系`);
                        resolve(result);
                    } catch (error) {
                        console.error('Failed to parse Python analysis result:', error);
                        outputChannel.appendLine(`解析分析结果失败: ${error}`);
                        resolve([]);
                    }
                } else {
                    console.error('Python analysis failed with code:', code);
                    outputChannel.appendLine(`Python 分析失败，退出码: ${code}`);
                    if (stderr) {
                        console.error('stderr:', stderr);
                        outputChannel.appendLine(`Python 错误: ${stderr}`);
                    }
                    resolve([]);
                }
            });

            process.on('error', (error: Error) => {
                console.error('Failed to spawn Python process:', error);
                reject(error);
            });
        });
    }

    /**
     * 清除所有缓存
     */
    clearCache(): void {
        this.cache.clear();
    }

    /**
     * 清除指定文件的缓存
     */
    clearFileCache(filePath: string): void {
        this.cache.delete(filePath);
    }
}

/**
 * 重写装饰器提供者
 */
class OverrideDecorationProvider {
    private childOverrideDecorationType: vscode.TextEditorDecorationType;
    private parentOverriddenDecorationType: vscode.TextEditorDecorationType;
    private analyzer: PythonOverrideAnalyzer;

    constructor(context: vscode.ExtensionContext, analyzer: PythonOverrideAnalyzer) {
        this.analyzer = analyzer;
        
        // 子类重写父类的装饰器（向上箭头）
        this.childOverrideDecorationType = vscode.window.createTextEditorDecorationType({
            gutterIconPath: path.join(context.extensionPath, 'resources', 'override-up.svg'),
            gutterIconSize: '18px'
        });
        
        // 父类被子类重写的装饰器（向下箭头）
        this.parentOverriddenDecorationType = vscode.window.createTextEditorDecorationType({
            gutterIconPath: path.join(context.extensionPath, 'resources', 'override-down.svg'),
            gutterIconSize: '18px'
        });
    }

    /**
     * 更新装饰器
     */
    async updateDecorations(editor: vscode.TextEditor): Promise<void> {
        if (editor.document.languageId !== 'python') {
            return;
        }

        try {
            const overrides = await this.analyzer.analyzeFile(editor.document.fileName);
            
            const childOverrideDecorations: vscode.DecorationOptions[] = [];
            const parentOverriddenDecorations: vscode.DecorationOptions[] = [];

            for (const override of overrides) {
                const line = editor.document.lineAt(override.line - 1);
                const hoverMessage = this.createHoverMessage(override);
                
                const decoration = {
                    range: line.range,
                    hoverMessage
                };
                
                if (override.type === 'child_override') {
                    childOverrideDecorations.push(decoration);
                } else if (override.type === 'parent_overridden') {
                    parentOverriddenDecorations.push(decoration);
                }
            }

            editor.setDecorations(this.childOverrideDecorationType, childOverrideDecorations);
            editor.setDecorations(this.parentOverriddenDecorationType, parentOverriddenDecorations);
        } catch (error) {
            console.error('Failed to update decorations:', error);
        }
    }

    private createHoverMessage(override: OverrideInfo): vscode.MarkdownString {
        const markdown = new vscode.MarkdownString();
        markdown.isTrusted = true;
        
        if (override.type === 'child_override') {
            // 子类重写父类
            markdown.appendMarkdown(`**Override Method**: \`${override.method}\`\n\n`);
            markdown.appendMarkdown(`**Parent Class**: \`${override.base}\`\n\n`);
            
            if (override.signature) {
                markdown.appendMarkdown(`**Current Signature**: \`${override.signature}\`\n\n`);
            }
            
            if (override.base_signature) {
                markdown.appendMarkdown(`**Parent Signature**: \`${override.base_signature}\`\n\n`);
            }
            
            if (override.base_file_path) {
                const jumpCommand = `command:vscode.open?${encodeURIComponent(JSON.stringify([
                    vscode.Uri.file(override.base_file_path),
                    { selection: new vscode.Range(override.base_line! - 1, 0, override.base_line! - 1, 0) }
                ]))}`;
                markdown.appendMarkdown(`[Jump to parent definition](${jumpCommand})`);
            }
        } else if (override.type === 'parent_overridden') {
            // 父类被子类重写
            markdown.appendMarkdown(`**Overridden Method**: \`${override.method}\`\n\n`);
            markdown.appendMarkdown(`**Child Class**: \`${override.child}\`\n\n`);
            
            if (override.signature) {
                markdown.appendMarkdown(`**Parent Signature**: \`${override.signature}\`\n\n`);
            }
            
            if (override.child_signature) {
                markdown.appendMarkdown(`**Child Signature**: \`${override.child_signature}\`\n\n`);
            }
            
            if (override.child_file_path) {
                const jumpCommand = `command:vscode.open?${encodeURIComponent(JSON.stringify([
                    vscode.Uri.file(override.child_file_path),
                    { selection: new vscode.Range(override.child_line! - 1, 0, override.child_line! - 1, 0) }
                ]))}`;
                markdown.appendMarkdown(`[Jump to child implementation](${jumpCommand})`);
            }
        }
        
        return markdown;
    }

    dispose(): void {
        this.childOverrideDecorationType.dispose();
        this.parentOverriddenDecorationType.dispose();
    }
}

/**
 * CodeLens 提供者
 */
class OverrideCodeLensProvider implements vscode.CodeLensProvider {
    private analyzer: PythonOverrideAnalyzer;
    private _onDidChangeCodeLenses = new vscode.EventEmitter<void>();
    public readonly onDidChangeCodeLenses = this._onDidChangeCodeLenses.event;

    constructor(analyzer: PythonOverrideAnalyzer) {
        this.analyzer = analyzer;
    }

    async provideCodeLenses(document: vscode.TextDocument): Promise<vscode.CodeLens[]> {
        if (document.languageId !== 'python') {
            return [];
        }

        try {
            const overrides = await this.analyzer.analyzeFile(document.fileName);
            const codeLenses: vscode.CodeLens[] = [];

            for (const override of overrides) {
                const line = document.lineAt(override.line - 1);
                const range = new vscode.Range(override.line - 1, 0, override.line - 1, line.text.length);
                
                let command: vscode.Command;
                
                if (override.type === 'child_override') {
                    // 子类重写父类
                    command = {
                        title: `↑ Overrides ${override.base}.${override.method}`,
                        command: 'vscode.open',
                        arguments: [
                            vscode.Uri.file(override.base_file_path!),
                            { selection: new vscode.Range(override.base_line! - 1, 0, override.base_line! - 1, 0) }
                        ]
                    };
                } else if (override.type === 'parent_overridden') {
                    // 父类被子类重写
                    command = {
                        title: `↓ Overridden by ${override.child}.${override.method}`,
                        command: 'vscode.open',
                        arguments: [
                            vscode.Uri.file(override.child_file_path!),
                            { selection: new vscode.Range(override.child_line! - 1, 0, override.child_line! - 1, 0) }
                        ]
                    };
                } else {
                    continue; // 跳过未知类型
                }

                codeLenses.push(new vscode.CodeLens(range, command));
            }

            return codeLenses;
        } catch (error) {
            console.error('Failed to provide code lenses:', error);
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
    private debounceTimers = new Map<string, NodeJS.Timeout>();
    private decorationProvider: OverrideDecorationProvider;
    private codeLensProvider: OverrideCodeLensProvider;
    private analyzer: PythonOverrideAnalyzer;

    constructor(
        context: vscode.ExtensionContext,
        analyzer: PythonOverrideAnalyzer,
        decorationProvider: OverrideDecorationProvider,
        codeLensProvider: OverrideCodeLensProvider
    ) {
        this.analyzer = analyzer;
        this.decorationProvider = decorationProvider;
        this.codeLensProvider = codeLensProvider;
        
        this.setupEventListeners(context);
    }

    private setupEventListeners(context: vscode.ExtensionContext): void {
        // 监听活动编辑器变化
        context.subscriptions.push(
            vscode.window.onDidChangeActiveTextEditor((editor: vscode.TextEditor | undefined) => {
                if (editor && editor.document.languageId === 'python') {
                    this.scheduleAnalysis(editor);
                }
            })
        );

        // 监听文档保存
        context.subscriptions.push(
            vscode.workspace.onDidSaveTextDocument((document: vscode.TextDocument) => {
                if (document.languageId === 'python') {
                    this.analyzer.clearFileCache(document.fileName);
                    const editor = vscode.window.activeTextEditor;
                    if (editor && editor.document === document) {
                        this.scheduleAnalysis(editor, 100); // 保存后快速刷新
                    }
                }
            })
        );

        // 监听文档关闭
        context.subscriptions.push(
            vscode.workspace.onDidCloseTextDocument((document: vscode.TextDocument) => {
                if (document.languageId === 'python') {
                    this.analyzer.clearFileCache(document.fileName);
                    const timerId = this.debounceTimers.get(document.fileName);
                    if (timerId) {
                        clearTimeout(timerId);
                        this.debounceTimers.delete(document.fileName);
                    }
                }
            })
        );
    }

    private scheduleAnalysis(editor: vscode.TextEditor, delay?: number): void {
        const filePath = editor.document.fileName;
        const config = vscode.workspace.getConfiguration('PythonOverrideHint');
        const debounceDelay = delay ?? config.get<number>('debounceDelay', 1000);

        // 清除之前的定时器
        const existingTimer = this.debounceTimers.get(filePath);
        if (existingTimer) {
            clearTimeout(existingTimer);
        }

        // 设置新的定时器
        const timer = setTimeout(async () => {
            try {
                await this.decorationProvider.updateDecorations(editor);
                this.codeLensProvider.refresh();
            } catch (error) {
                console.error('Analysis failed:', error);
            } finally {
                this.debounceTimers.delete(filePath);
            }
        }, debounceDelay);

        this.debounceTimers.set(filePath, timer);
    }

    async refreshAnalysis(): Promise<void> {
        this.analyzer.clearCache();
        const editor = vscode.window.activeTextEditor;
        if (editor && editor.document.languageId === 'python') {
            await this.decorationProvider.updateDecorations(editor);
            this.codeLensProvider.refresh();
        }
    }
}

/**
 * 激活插件
 */
export function activate(context: vscode.ExtensionContext) {
    // 创建输出通道
    outputChannel = vscode.window.createOutputChannel('Python Override Hint');
    context.subscriptions.push(outputChannel);
    
    outputChannel.appendLine('Python Override Hint Activated');
    
    const config = vscode.workspace.getConfiguration('PythonOverrideHint');
    const enabled = config.get<boolean>('enabled', true);
    
    if (!enabled) {
        outputChannel.appendLine('插件已禁用');
        return;
    }

    // 延迟初始化以兼容 Pylance
    const hasPylance = isPylanceInstalled();
    const delay = hasPylance ? 2000 : 0;
    
    outputChannel.appendLine(`检测到 Pylance: ${hasPylance}, 延迟初始化: ${delay}ms`);
    
    setTimeout(() => {
        initializePlugin(context);
    }, delay);
}

/**
 * 检测是否安装了 Pylance
 */
function isPylanceInstalled(): boolean {
    const pylanceExtension = vscode.extensions.getExtension('ms-python.vscode-pylance');
    return pylanceExtension !== undefined;
}

/**
 * 初始化插件核心功能
 */
function initializePlugin(context: vscode.ExtensionContext) {
    const hasPylance = isPylanceInstalled();
    outputChannel.appendLine('开始初始化插件核心组件...');

    // 创建核心组件
    const analyzer = new PythonOverrideAnalyzer(context);
    const decorationProvider = new OverrideDecorationProvider(context, analyzer);
    const codeLensProvider = new OverrideCodeLensProvider(analyzer);
    const documentManager = new DocumentManager(context, analyzer, decorationProvider, codeLensProvider);
    
    outputChannel.appendLine('核心组件创建完成');

    // 注册 CodeLens 提供者
    context.subscriptions.push(
        vscode.languages.registerCodeLensProvider(
            { language: 'python' },
            codeLensProvider
        )
    );

    // 注册刷新命令
    context.subscriptions.push(
		vscode.commands.registerCommand('PythonOverrideHint.refresh', async () => {
            await documentManager.refreshAnalysis();
            vscode.window.showInformationMessage('Python Override Hint analysis refreshed');
        })
    );

    // 注册测试命令
    context.subscriptions.push(
		vscode.commands.registerCommand('PythonOverrideHint.test', async () => {
            const activeEditor = vscode.window.activeTextEditor;
            if (!activeEditor) {
                vscode.window.showWarningMessage('No active editor found');
                return;
            }
            
            if (activeEditor.document.languageId !== 'python') {
                vscode.window.showWarningMessage('Current file is not a Python file');
                return;
            }

            try {
                const overrides = await analyzer.analyzeFile(activeEditor.document.fileName);
                const message = `Found ${overrides.length} override methods in ${path.basename(activeEditor.document.fileName)}`;
                vscode.window.showInformationMessage(message);
            } catch (error) {
                console.error('Test failed:', error);
                vscode.window.showErrorMessage(`Test failed: ${error}`);
            }
        })
    );

    // 注册状态显示命令
    context.subscriptions.push(
		vscode.commands.registerCommand('PythonOverrideHint.showStatus', async () => {
            const config = vscode.workspace.getConfiguration('PythonOverrideHint');
            const pythonPath = config.get<string>('pythonPath', 'python3');
            const enabled = config.get<boolean>('enabled', true);
            
            const statusMessage = `Plugin Status:
- Enabled: ${enabled}
- Python Path: ${pythonPath}
- Active Editor: ${vscode.window.activeTextEditor?.document.fileName || 'None'}
- Language: ${vscode.window.activeTextEditor?.document.languageId || 'None'}
- Pylance Detected: ${hasPylance}
- Initialization Delay: ${hasPylance ? '2 seconds (for Pylance compatibility)' : 'None'}`;
            
            vscode.window.showInformationMessage('Plugin initialized successfully! Check console for detailed status');
        })
    );

    outputChannel.appendLine('命令和提供者注册完成');

    // 初始化当前编辑器（延迟一点以确保 Pylance 已加载）
    setTimeout(() => {
        const activeEditor = vscode.window.activeTextEditor;
        
        if (activeEditor && activeEditor.document.languageId === 'python') {
            outputChannel.appendLine(`初始化当前 Python 文件: ${activeEditor.document.fileName}`);
            decorationProvider.updateDecorations(activeEditor);
        }
    }, 1000);
    
    outputChannel.appendLine('插件初始化完成');

    // 清理资源
    context.subscriptions.push({
        dispose: () => {
            decorationProvider.dispose();
        }
    });
}

/**
 * 停用插件
 */
export function deactivate() {
    console.log('Python Override Hint plugin is now deactivated');
}