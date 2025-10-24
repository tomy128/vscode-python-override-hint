#!/usr/bin/env python3
"""
Python Override Hint - 高性能分析器
支持服务器模式、增量分析和智能缓存
"""

import ast
import sys
import json
import os
import time
import hashlib
from pathlib import Path
from typing import Dict, List, Optional, Set, Tuple, Any, Union
from dataclasses import dataclass, asdict
import threading
import queue
import argparse

try:
    import jedi
    from jedi.api import Script
    from jedi.api.classes import Name
    JEDI_AVAILABLE = True
except ImportError:
    JEDI_AVAILABLE = False
    print("Warning: Jedi not available. Some features may be limited.", file=sys.stderr)

@dataclass
class OverrideInfo:
    """重写方法信息"""
    class_name: str
    method: str
    line: int
    signature: Optional[str] = None
    type: str = 'child_override'  # 'child_override' or 'parent_overridden'
    
    # 子类重写父类时的字段
    base: Optional[str] = None
    base_file: Optional[str] = None
    base_file_path: Optional[str] = None
    base_line: Optional[int] = None
    base_signature: Optional[str] = None
    
    # 父类被子类重写时的字段
    child: Optional[str] = None
    child_file: Optional[str] = None
    child_file_path: Optional[str] = None
    child_line: Optional[int] = None
    child_signature: Optional[str] = None

class FileCache:
    """文件缓存管理器"""
    
    def __init__(self):
        self.cache: Dict[str, Dict] = {}
        self.file_hashes: Dict[str, str] = {}
        
    def get_file_hash(self, file_path: str) -> str:
        """获取文件内容哈希"""
        try:
            with open(file_path, 'rb') as f:
                return hashlib.md5(f.read()).hexdigest()
        except (IOError, OSError):
            return ""
    
    def is_file_changed(self, file_path: str) -> bool:
        """检查文件是否已更改"""
        current_hash = self.get_file_hash(file_path)
        old_hash = self.file_hashes.get(file_path)
        
        if current_hash != old_hash:
            self.file_hashes[file_path] = current_hash
            return True
        return False
    
    def get_cached_result(self, file_path: str) -> Optional[List[OverrideInfo]]:
        """获取缓存的分析结果"""
        if file_path in self.cache and not self.is_file_changed(file_path):
            cached_data = self.cache[file_path]
            return [OverrideInfo(**item) for item in cached_data.get('overrides', [])]
        return None
    
    def cache_result(self, file_path: str, overrides: List[OverrideInfo]):
        """缓存分析结果"""
        self.cache[file_path] = {
            'overrides': [asdict(override) for override in overrides],
            'timestamp': time.time()
        }

class ProjectAnalyzer:
    """项目级分析器"""
    
    def __init__(self, workspace_root: str):
        self.workspace_root = workspace_root
        self.file_cache = FileCache()
        self.class_hierarchy: Dict[str, Dict] = {}
        self.method_definitions: Dict[str, List[Dict]] = {}
        self.last_full_scan = 0
        self.scan_interval = 300  # 5分钟重新扫描一次
        
    def should_rescan(self) -> bool:
        """判断是否需要重新扫描项目"""
        return time.time() - self.last_full_scan > self.scan_interval
    
    def find_python_files(self, max_files: int = 200) -> List[str]:
        """查找项目中的Python文件"""
        python_files = []
        workspace_path = Path(self.workspace_root)
        
        # 排除常见的非源码目录
        exclude_dirs = {
            '__pycache__', '.git', '.vscode', 'node_modules', 
            '.pytest_cache', '.mypy_cache', 'venv', 'env',
            '.tox', 'build', 'dist', '.eggs'
        }
        
        try:
            for py_file in workspace_path.rglob('*.py'):
                # 检查是否在排除目录中
                if any(exclude_dir in py_file.parts for exclude_dir in exclude_dirs):
                    continue
                    
                python_files.append(str(py_file))
                if len(python_files) >= max_files:
                    break
                    
        except (OSError, PermissionError):
            pass
            
        return python_files
    
    def build_class_hierarchy(self, files: List[str]) -> None:
        """构建类继承层次结构"""
        self.class_hierarchy.clear()
        self.method_definitions.clear()
        
        for file_path in files:
            try:
                self._analyze_file_structure(file_path)
            except Exception:
                continue  # 忽略解析错误的文件
    
    def _analyze_file_structure(self, file_path: str) -> None:
        """分析单个文件的结构"""
        try:
            with open(file_path, 'r', encoding='utf-8') as f:
                content = f.read()
            
            tree = ast.parse(content, filename=file_path)
            
            for node in ast.walk(tree):
                if isinstance(node, ast.ClassDef):
                    self._process_class_definition(node, file_path)
                    
        except (SyntaxError, UnicodeDecodeError, OSError):
            pass
    
    def _process_class_definition(self, class_node: ast.ClassDef, file_path: str) -> None:
        """处理类定义"""
        class_name = class_node.name
        base_classes = []
        
        # 提取基类信息
        for base in class_node.bases:
            if isinstance(base, ast.Name):
                base_classes.append(base.id)
            elif isinstance(base, ast.Attribute):
                base_classes.append(self._get_attribute_name(base))
        
        # 存储类信息
        self.class_hierarchy[class_name] = {
            'file_path': file_path,
            'line': class_node.lineno,
            'bases': base_classes,
            'methods': {}
        }
        
        # 提取方法信息
        for node in class_node.body:
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                method_name = node.name
                signature = self._extract_method_signature(node)
                
                self.class_hierarchy[class_name]['methods'][method_name] = {
                    'line': node.lineno,
                    'signature': signature,
                    'file_path': file_path
                }
                
                # 全局方法索引
                method_key = f"{class_name}.{method_name}"
                if method_key not in self.method_definitions:
                    self.method_definitions[method_key] = []
                
                self.method_definitions[method_key].append({
                    'class': class_name,
                    'file_path': file_path,
                    'line': node.lineno,
                    'signature': signature
                })
    
    def _get_attribute_name(self, node: ast.Attribute) -> str:
        """获取属性的完整名称"""
        if isinstance(node.value, ast.Name):
            return f"{node.value.id}.{node.attr}"
        elif isinstance(node.value, ast.Attribute):
            return f"{self._get_attribute_name(node.value)}.{node.attr}"
        return node.attr
    
    def _extract_method_signature(self, func_node: Union[ast.FunctionDef, ast.AsyncFunctionDef]) -> str:
        """提取方法签名"""
        args = []
        
        # 处理普通参数
        for arg in func_node.args.args:
            arg_str = arg.arg
            if arg.annotation:
                arg_str += f": {ast.unparse(arg.annotation)}"
            args.append(arg_str)
        
        # 处理默认参数
        defaults = func_node.args.defaults
        if defaults:
            default_offset = len(args) - len(defaults)
            for i, default in enumerate(defaults):
                args[default_offset + i] += f" = {ast.unparse(default)}"
        
        # 处理返回类型注解
        return_annotation = ""
        if func_node.returns:
            return_annotation = f" -> {ast.unparse(func_node.returns)}"
        
        return f"({', '.join(args)}){return_annotation}"
    
    def find_overrides(self, target_file: str) -> List[OverrideInfo]:
        """查找指定文件中的重写关系（包括双向检测）"""
        # 如果需要重新扫描或者是第一次扫描
        if self.should_rescan() or not self.class_hierarchy:
            python_files = self.find_python_files()
            self.build_class_hierarchy(python_files)
            self.last_full_scan = time.time()
        
        # 分析目标文件
        overrides = self._analyze_target_file(target_file)
        
        # 添加跨文件的父类被重写检测
        overrides.extend(self._find_parent_overridden_in_file(target_file))
        
        return overrides
    
    def _find_parent_overridden_in_file(self, target_file: str) -> List[OverrideInfo]:
        """查找目标文件中被其他文件的子类重写的方法"""
        overrides = []
        
        # 获取目标文件中的所有类
        target_classes = {}
        try:
            with open(target_file, 'r', encoding='utf-8') as f:
                content = f.read()
            tree = ast.parse(content, filename=target_file)
            
            for node in ast.walk(tree):
                if isinstance(node, ast.ClassDef):
                    target_classes[node.name] = node
        except:
            return overrides
        
        # 遍历项目中的所有类，查找继承自目标文件中类的子类
        for class_name, class_info in self.class_hierarchy.items():
            if class_info['file_path'] == target_file:
                continue  # 跳过同一文件中的类
                
            # 检查这个类是否继承自目标文件中的类
            for base_class in class_info.get('bases', []):
                if base_class in target_classes:
                    # 找到了继承关系，检查方法重写
                    parent_class_node = target_classes[base_class]
                    child_class_info = class_info
                    
                    # 获取子类的方法
                    child_methods = child_class_info.get('methods', {})
                    
                    # 检查父类的每个方法是否被子类重写
                    for method_node in parent_class_node.body:
                        if isinstance(method_node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                            method_name = method_node.name
                            if method_name in child_methods:
                                # 父类方法被子类重写
                                child_method_info = child_methods[method_name]
                                override = OverrideInfo(
                                    class_name=base_class,
                                    method=method_name,
                                    line=method_node.lineno,
                                    signature=self._extract_method_signature(method_node),
                                    type='parent_overridden',
                                    child=class_name,
                                    child_file=os.path.basename(child_class_info['file_path']),
                                    child_file_path=child_class_info['file_path'],
                                    child_line=child_method_info['line'],
                                    child_signature=child_method_info['signature']
                                )
                                overrides.append(override)
        
        return overrides
    
    def _analyze_target_file(self, file_path: str) -> List[OverrideInfo]:
        """分析目标文件中的重写关系"""
        overrides = []
        
        try:
            with open(file_path, 'r', encoding='utf-8') as f:
                content = f.read()
            
            tree = ast.parse(content, filename=file_path)
            
            for node in ast.walk(tree):
                if isinstance(node, ast.ClassDef):
                    class_overrides = self._find_class_overrides(node, file_path)
                    overrides.extend(class_overrides)
                    
        except (SyntaxError, UnicodeDecodeError, OSError):
            pass
        
        return overrides
    
    def _find_class_overrides(self, class_node: ast.ClassDef, file_path: str) -> List[OverrideInfo]:
        """查找类中的重写关系"""
        overrides = []
        class_name = class_node.name
        
        # 获取基类
        base_classes = self._get_base_classes(class_node)
        
        # 分析每个方法
        for method_node in class_node.body:
            if isinstance(method_node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                method_name = method_node.name
                
                # 查找父类中的同名方法
                for base_class in base_classes:
                    base_method = self._find_method_in_class(base_class, method_name)
                    if base_method:
                        # 子类重写父类方法
                        override = OverrideInfo(
                            class_name=class_name,
                            method=method_name,
                            line=method_node.lineno,
                            signature=self._extract_method_signature(method_node),
                            type='child_override',
                            base=base_class,
                            base_file=os.path.basename(base_method['file_path']),
                            base_file_path=base_method['file_path'],
                            base_line=base_method['line'],
                            base_signature=base_method['signature']
                        )
                        overrides.append(override)
                        
                        # 如果父类在同一文件中，添加被重写标记
                        if base_method['file_path'] == file_path:
                            parent_override = OverrideInfo(
                                class_name=base_class,
                                method=method_name,
                                line=base_method['line'],
                                signature=base_method['signature'],
                                type='parent_overridden',
                                child=class_name,
                                child_file=os.path.basename(file_path),
                                child_file_path=file_path,
                                child_line=method_node.lineno,
                                child_signature=self._extract_method_signature(method_node)
                            )
                            overrides.append(parent_override)
        
        return overrides
    
    def _get_base_classes(self, class_node: ast.ClassDef) -> List[str]:
        """获取类的基类列表"""
        base_classes = []
        for base in class_node.bases:
            if isinstance(base, ast.Name):
                base_classes.append(base.id)
            elif isinstance(base, ast.Attribute):
                base_classes.append(self._get_attribute_name(base))
        return base_classes
    
    def _find_method_in_class(self, class_name: str, method_name: str) -> Optional[Dict]:
        """在指定类中查找方法"""
        if class_name in self.class_hierarchy:
            class_info = self.class_hierarchy[class_name]
            if method_name in class_info['methods']:
                return class_info['methods'][method_name]
            
            # 递归查找基类
            for base_class in class_info['bases']:
                base_method = self._find_method_in_class(base_class, method_name)
                if base_method:
                    return base_method
        
        return None

class OverrideAnalyzerServer:
    """分析器服务器模式"""
    
    def __init__(self):
        self.analyzers: Dict[str, ProjectAnalyzer] = {}
        self.message_queue = queue.Queue()
        self.running = False
        
    def start_server(self):
        """启动服务器模式"""
        self.running = True
        # 发送JSON格式的ready信号
        ready_signal = {"type": "ready"}
        print(json.dumps(ready_signal), flush=True)
        
        try:
            while self.running:
                try:
                    line = input()
                    if line.strip():
                        message = json.loads(line)
                        response = self.handle_message(message)
                        print(json.dumps(response), flush=True)
                except (EOFError, KeyboardInterrupt):
                    break
                except json.JSONDecodeError:
                    continue
                except Exception as e:
                    error_response = {
                        'id': 'unknown',
                        'error': str(e)
                    }
                    print(json.dumps(error_response), flush=True)
        finally:
            self.running = False
    
    def handle_message(self, message: Dict) -> Dict:
        """处理客户端消息"""
        msg_id = message.get('id', 'unknown')
        command = message.get('command')
        data = message.get('data', {})
        
        try:
            if command == 'analyze':
                file_path = data.get('file_path')
                if not file_path:
                    raise ValueError("file_path is required")
                
                result = self.analyze_file(file_path)
                return {
                    'id': msg_id,
                    'result': [asdict(override) for override in result]
                }
            else:
                raise ValueError(f"Unknown command: {command}")
                
        except Exception as e:
            return {
                'id': msg_id,
                'error': str(e)
            }
    
    def analyze_file(self, file_path: str) -> List[OverrideInfo]:
        """分析文件"""
        # 确定工作区根目录
        workspace_root = self.find_workspace_root(file_path)
        
        # 获取或创建分析器
        if workspace_root not in self.analyzers:
            self.analyzers[workspace_root] = ProjectAnalyzer(workspace_root)
        
        analyzer = self.analyzers[workspace_root]
        return analyzer.find_overrides(file_path)
    
    def find_workspace_root(self, file_path: str) -> str:
        """查找工作区根目录"""
        current_dir = Path(file_path).parent
        
        # 向上查找包含常见项目标识的目录
        project_markers = {'.git', '.vscode', 'setup.py', 'pyproject.toml', 'requirements.txt'}
        
        while current_dir != current_dir.parent:
            if any((current_dir / marker).exists() for marker in project_markers):
                return str(current_dir)
            current_dir = current_dir.parent
        
        # 如果没找到，使用文件所在目录
        return str(Path(file_path).parent)

def analyze_file_standalone(file_path: str, workspace_root: str) -> List[Dict]:
    """独立模式分析文件"""
    analyzer = ProjectAnalyzer(workspace_root)
    overrides = analyzer.find_overrides(file_path)
    return [asdict(override) for override in overrides]

def main():
    parser = argparse.ArgumentParser(description='Python Override Analyzer')
    parser.add_argument('--server', action='store_true', help='Run in server mode')
    parser.add_argument('file_path', nargs='?', help='File to analyze (standalone mode)')
    parser.add_argument('workspace_root', nargs='?', help='Workspace root (standalone mode)')
    
    args = parser.parse_args()
    
    if args.server:
        # 服务器模式
        server = OverrideAnalyzerServer()
        server.start_server()
    else:
        # 独立模式（向后兼容）
        if not args.file_path:
            print("Error: file_path is required in standalone mode", file=sys.stderr)
            sys.exit(1)
        
        workspace_root = args.workspace_root or str(Path(args.file_path).parent)
        
        try:
            result = analyze_file_standalone(args.file_path, workspace_root)
            print(json.dumps(result))
        except Exception as e:
            print(f"Error: {e}", file=sys.stderr)
            sys.exit(1)

if __name__ == '__main__':
    main()