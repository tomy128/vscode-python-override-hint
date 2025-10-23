"""
基类示例文件
"""


class Animal:
    """动物基类"""

    def __init__(self, name):
        self.name = name

    def speak(self):
        """动物叫声"""
        pass

    def move(self):
        """动物移动"""
        print(f"{self.name} is moving")

    def eat(self):
        """动物进食"""
        print(f"{self.name} is eating")


class Vehicle:
    """交通工具基类"""

    def __init__(self, brand):
        self.brand = brand

    def start(self):
        """启动"""
        print(f"{self.brand} is starting")

    def stop(self):
        """停止"""
        print(f"{self.brand} is stopping")
