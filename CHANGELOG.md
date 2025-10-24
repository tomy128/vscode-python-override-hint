# Changelog

All notable changes to the "Python Override Hint" extension will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.0.1] - 2025-10-24

### Added
- 新增类级 CodeLens 设置：`PythonOverrideHint.classCodeLens.enabled` 与 `PythonOverrideHint.classCodeLens.style`
- 支持 QuickPick 选择关系并跳转（`pythonOverrideHint.quickPickRelations`）

### Changed
- 统一命令 ID 大小写，修复多窗口下命令未注册问题
- CodeLens 配置变更后自动刷新展示
- 更新 README，补充新配置项与资源说明
- 优化打包忽略清单（`.vscodeignore`），排除测试与预览文件，减小 VSIX 体积
- 优化了 Python 分析器的性能和稳定性
- 改进了类型注解和错误处理
- 修复了 AST 解析中的类型兼容性问题
- 增强了并发处理和错误恢复机制

### Fixed
- 修复了 AsyncFunctionDef 类型处理问题
- 修复了函数返回类型注解问题
- 改进了 Jedi 集成的类型安全性

### Removed
- 删除未使用的资源文件：`resources/icon.svg`


## [1.0.0] - 2024-12-19

### Added
- 初始版本发布
- Python 类方法重写的可视化提示功能
- 支持显示子类重写父类方法的标识（向上箭头图标）
- 支持显示父类被子类重写方法的标识（向下箭头图标）
- 基于 AST 的静态代码分析
- 支持并发索引构建和缓存机制
- 可配置的图标大小和样式
- 支持增量文件分析
- 命令面板集成（刷新分析）

### Features
- **Override Detection**: 自动检测 Python 类中的方法重写关系
- **Visual Indicators**: 在编辑器行号区域显示直观的图标提示
- **Performance Optimized**: 使用缓存和并发处理提升分析性能
- **Workspace Support**: 支持整个工作区的代码分析
- **Real-time Updates**: 文件保存时自动更新分析结果

### Technical Details
- 使用 TypeScript 开发的 VS Code 扩展
- Python 后端分析器支持复杂的继承关系
- 支持异步函数和类方法的检测
- 兼容 Python 3.6+ 语法特性