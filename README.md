# Python Override Hint

一个 VSCode 插件，用于在 Python 文件中直观显示哪些方法是重写父类方法（override）的，类似于 PyCharm 中的功能。

## ✨ 功能特性

- 🎯 **可视化指示器**：在编辑器左侧 gutter 显示重写方法的图标
- 📝 **CodeLens 支持**：在方法上方显示重写信息
- 🔍 **智能悬停**：鼠标悬停显示详细的重写信息
- 🚀 **快速跳转**：点击可直接跳转到父类方法定义
- ⚡ **性能优化**：智能缓存和防抖机制
- 🔄 **实时更新**：文件保存时自动刷新分析结果

## 📋 系统要求

- VSCode 1.74.0 或更高版本
- Python 3.8 或更高版本
- Jedi 库（用于 Python 代码分析）

## 🚀 安装步骤

### 1. 安装 Python 依赖

```bash
pip install jedi
```

### 2. 安装插件

#### 方法一：从源码安装（推荐）

```bash
# 克隆或下载项目到本地
cd vscode-python-override

# 安装 Node.js 依赖
npm install

# 编译 TypeScript 代码
npm run compile

# 打包插件
npm run package
```

这将生成一个 `.vsix` 文件，然后在 VSCode 中：
1. 按 `Ctrl+Shift+P` 打开命令面板
2. 输入 "Extensions: Install from VSIX..."
3. 选择生成的 `.vsix` 文件

#### 方法二：开发模式运行

```bash
# 在项目目录中
npm install
npm run compile

# 在 VSCode 中打开项目
code .

# 按 F5 启动调试模式
```

## 🎮 使用方法

### 基本使用

1. 在 VSCode 中打开包含 Python 类继承的项目
2. 打开任意 Python 文件
3. 插件会自动分析并在重写方法的行号左侧显示橙色图标
4. 鼠标悬停在图标上查看详细信息
5. 点击图标或 CodeLens 跳转到父类方法定义

### 手动刷新

- 使用命令面板：`Ctrl+Shift+P` → `Python Override Hint: Refresh`
- 或者保存文件时自动刷新

### 配置选项

在 VSCode 设置中搜索 "Python Override Hint" 可以找到以下配置：

- `PythonOverrideHint.enabled`: 启用/禁用插件（默认：true）
- `PythonOverrideHint.debounceDelay`: 分析延迟时间，毫秒（默认：1000）
- `PythonOverrideHint.pythonPath`: Python 解释器路径（默认："python"）
- `PythonOverrideHint.classCodeLens.enabled`: 显示类级 CodeLens（类定义行）（默认：true）
- `PythonOverrideHint.classCodeLens.style`: 类级 CodeLens 显示方式（默认：`summary`）。`summary` 显示数量摘要并支持 QuickPick；`list` 直接列出名称（同样支持 QuickPick）。

## 📁 项目结构

```
vscode-python-override/
├── package.json              # 插件配置和依赖
├── tsconfig.json             # TypeScript 配置
├── src/
│   └── extension.ts          # 插件主逻辑
├── python/
│   └── analyze_override.py   # Python 分析脚本
├── resources/
│   ├── icon.png              # 插件图标
│   ├── override-up.svg       # 向上箭头图标
│   ├── override-down.svg     # 向下箭头图标
│   └── override-both.svg     # 复合箭头图标（同时显示上下）
└── README.md                 # 说明文档
```

## 🔧 开发指南

### 本地开发

```bash
# 安装依赖
npm install

# 编译 TypeScript
npm run compile

# 监听文件变化并自动编译
npm run watch

# 在 VSCode 中按 F5 启动调试
```

### 代码结构说明

#### TypeScript 部分 (`src/extension.ts`)

- **PythonOverrideAnalyzer**: 负责调用 Python 脚本进行分析
- **OverrideDecorationProvider**: 管理编辑器装饰器（图标显示）
- **OverrideCodeLensProvider**: 提供 CodeLens 功能
- **DocumentManager**: 管理文档事件和防抖逻辑

#### Python 部分 (`python/analyze_override.py`)

- **OverrideAnalyzer**: 主分析类，使用 Jedi 进行代码分析
- 支持项目级缓存，提高性能
- 输出 JSON 格式的分析结果

### 分析结果格式

```json
[
  {
    "class": "Child",
    "method": "run",
    "line": 12,
    "base": "Base",
    "base_file": "base.py",
    "base_file_path": "/path/to/base.py",
    "base_line": 5,
    "signature": "def run(self, arg):",
    "base_signature": "def run(self, arg):"
  }
]
```

## 📦 打包发布

```bash
# 安装 vsce（如果还没有安装）
npm install -g vsce

# 打包插件
npm run package

# 这将生成 python-override-hint-1.0.0.vsix 文件
```

## 🐛 故障排除

### 常见问题

1. **图标不显示**
   - 检查 Python 是否正确安装
   - 确认 Jedi 库已安装：`pip install jedi`
   - 检查插件是否已启用

2. **分析速度慢**
   - 调整 `PythonOverrideHint.debounceDelay` 设置
   - 确保项目不包含过多的 Python 文件

3. **跳转功能不工作**
   - 确认父类文件存在且可访问
   - 检查文件路径是否正确

### 调试模式

在开发模式下，可以在 VSCode 的开发者控制台中查看详细日志：
1. 按 `Ctrl+Shift+I` 打开开发者工具
2. 查看 Console 标签页中的日志信息

## 🤝 贡献

欢迎提交 Issue 和 Pull Request！

## 📄 许可证

MIT License

## 🙏 致谢

- [Jedi](https://github.com/davidhalter/jedi) - Python 代码分析库
- [VSCode Extension API](https://code.visualstudio.com/api) - 插件开发框架
