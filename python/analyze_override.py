#!/usr/bin/env python3
"""
Python Override Analyzer
使用 Jedi 分析 Python 文件中的方法重写关系
"""

import json
import sys
import os
import argparse
from pathlib import Path
from typing import List, Dict, Any, Optional
import ast

try:
    import jedi
except ImportError:
    print(json.dumps(
        {"error": "Jedi library not found. Please install: pip install jedi"}))
    sys.exit(1)


class OverrideAnalyzer:
    """Python 方法重写分析器"""

    def __init__(
            self,
            workspace_path: str,
            use_cache: bool = True,
            cache_dir: Optional[str] = None):
        self.workspace_path = Path(workspace_path).resolve()
        self.use_cache = use_cache
        self._init_project()

    def _init_project(self):
        """初始化 Jedi 项目"""
        try:
            self.project = jedi.Project(self.workspace_path)
        except Exception:
            self.project = None

    def _get_class_methods_from_ast(
            self, file_path: str) -> Dict[str, Dict[str, Any]]:
        """使用 AST 解析获取类和方法信息"""
        classes_info = {}

        try:
            with open(file_path, 'r', encoding='utf-8') as f:
                source = f.read()

            tree = ast.parse(source)

            for node in ast.walk(tree):
                if isinstance(node, ast.ClassDef):
                    class_name = node.name
                    methods = {}
                    base_classes = [
                        base.id for base in node.bases if isinstance(
                            base, ast.Name)]

                    for item in node.body:
                        if isinstance(item, ast.FunctionDef):
                            methods[item.name] = {
                                'line': item.lineno,
                                'signature': self._get_function_signature(item)
                            }

                    classes_info[class_name] = {
                        'methods': methods,
                        'bases': base_classes,
                        'line': node.lineno
                    }
        except Exception:
            pass

        return classes_info

    def _get_function_signature(self, func_node: ast.FunctionDef) -> str:
        """从 AST 节点获取函数签名"""
        try:
            args = []
            for arg in func_node.args.args:
                args.append(arg.arg)
            return f"{func_node.name}({', '.join(args)})"
        except Exception:
            return f"{func_node.name}()"

    def _find_base_class_methods(
            self, base_class_name: str, workspace_path: str) -> Dict[str, Dict[str, Any]]:
        """查找基类的方法"""
        methods = {}

        # 搜索工作区中的 Python 文件
        for py_file in Path(workspace_path).rglob("*.py"):
            try:
                classes_info = self._get_class_methods_from_ast(str(py_file))
                if base_class_name in classes_info:
                    base_info = classes_info[base_class_name]
                    for method_name, method_info in base_info['methods'].items(
                    ):
                        methods[method_name] = {
                            'line': method_info['line'],
                            'signature': method_info['signature'],
                            'file': str(py_file),
                            'class': base_class_name
                        }
                    break
            except Exception:
                continue

        return methods

    def _find_overridden_methods(self, file_path: str) -> List[Dict[str, Any]]:
        """查找文件中的重写方法"""
        overrides = []

        try:
            # 获取当前文件的类信息
            classes_info = self._get_class_methods_from_ast(file_path)

            for class_name, class_info in classes_info.items():
                # 检查每个基类
                for base_class in class_info['bases']:
                    # 获取基类的方法
                    base_methods = self._find_base_class_methods(
                        base_class, str(self.workspace_path))

                    # 检查当前类的方法是否重写了基类方法
                    for method_name, method_info in class_info['methods'].items(
                    ):
                        if method_name in base_methods:
                            base_method = base_methods[method_name]
                            override_info = {
                                'class': class_name,
                                'method': method_name,
                                'line': method_info['line'],
                                'base': base_class,
                                'base_file': os.path.basename(base_method['file']),
                                'base_file_path': base_method['file'],
                                'base_line': base_method['line'],
                                'signature': method_info['signature'],
                                'base_signature': base_method['signature'],
                                'type': 'child_override'  # 子类重写父类
                            }
                            overrides.append(override_info)
        except Exception:
            pass

        return overrides

    def _find_overriding_methods(self, file_path: str) -> List[Dict[str, Any]]:
        """查找当前文件中被子类重写的方法（反向查找）"""
        overriding = []

        try:
            # 获取当前文件的类信息
            current_classes = self._get_class_methods_from_ast(file_path)

            # 搜索工作区中的所有 Python 文件
            for py_file in Path(self.workspace_path).rglob("*.py"):
                if str(py_file) == file_path:
                    continue  # 跳过当前文件

                try:
                    # 获取其他文件的类信息
                    other_classes = self._get_class_methods_from_ast(
                        str(py_file))

                    for other_class_name, other_class_info in other_classes.items():
                        # 检查其他类是否继承了当前文件中的类
                        for base_class in other_class_info['bases']:
                            if base_class in current_classes:
                                # 找到继承关系，检查方法重写
                                current_class_methods = current_classes[base_class]['methods']

                                for method_name, other_method_info in other_class_info['methods'].items(
                                ):
                                    if method_name in current_class_methods:
                                        current_method = current_class_methods[method_name]
                                        override_info = {
                                            'class': base_class,
                                            'method': method_name,
                                            'line': current_method['line'],
                                            'child': other_class_name,
                                            'child_file': os.path.basename(str(py_file)),
                                            'child_file_path': str(py_file),
                                            'child_line': other_method_info['line'],
                                            'signature': current_method['signature'],
                                            'child_signature': other_method_info['signature'],
                                            'type': 'parent_overridden'  # 父类被子类重写
                                        }
                                        overriding.append(override_info)
                except Exception:
                    continue
        except Exception:
            pass

        return overriding

    def analyze_file(self, file_path: str) -> List[Dict[str, Any]]:
        """分析文件中的方法重写"""
        file_path = str(Path(file_path).resolve())

        try:
            # 查找子类重写父类的方法
            child_overrides = self._find_overridden_methods(file_path)

            # 查找父类被子类重写的方法
            parent_overridden = self._find_overriding_methods(file_path)

            # 合并结果
            all_overrides = child_overrides + parent_overridden

            return all_overrides
        except Exception as e:
            return [{"error": f"Analysis failed: {str(e)}"}]


def main():
    parser = argparse.ArgumentParser(
        description='Analyze Python method overrides')
    parser.add_argument('file_path', help='Path to the Python file to analyze')
    parser.add_argument(
        'workspace',
        nargs='?',
        help='Workspace root directory',
        default='.')
    parser.add_argument(
        '--no-cache',
        action='store_true',
        help='Disable caching')
    parser.add_argument(
        '--cache-dir',
        help='Cache directory',
        default='.jedi_cache')

    args = parser.parse_args()

    analyzer = OverrideAnalyzer(
        args.workspace,
        not args.no_cache,
        args.cache_dir)
    overrides = analyzer.analyze_file(args.file_path)

    # 输出 JSON 格式结果
    print(json.dumps(overrides, indent=2, ensure_ascii=False))


if __name__ == '__main__':
    main()
