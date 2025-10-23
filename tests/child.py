"""
子类示例文件 - 包含重写方法
"""

from base import Animal, Vehicle


class Dog(Animal):
    """狗类 - 继承自 Animal"""

    def __init__(self, name, breed):
        super().__init__(name)  # 重写 __init__ 方法
        self.breed = breed

    def speak(self):  # 重写 speak 方法
        """狗的叫声"""
        print(f"{self.name} says Woof!")

    def move(self):  # 重写 move 方法
        """狗的移动方式"""
        print(f"{self.name} is running around")

    def fetch(self):
        """狗特有的方法 - 不是重写"""
        print(f"{self.name} is fetching the ball")


class Cat(Animal):
    """猫类 - 继承自 Animal"""

    def speak(self):  # 重写 speak 方法
        """猫的叫声"""
        print(f"{self.name} says Meow!")

    def climb(self):
        """猫特有的方法 - 不是重写"""
        print(f"{self.name} is climbing")


class Car(Vehicle):
    """汽车类 - 继承自 Vehicle"""

    def __init__(self, brand, model):
        super().__init__(brand)  # 重写 __init__ 方法
        self.model = model

    def start(self):  # 重写 start 方法
        """汽车启动"""
        print(f"{self.brand} {self.model} engine is starting")

    def honk(self):
        """汽车特有的方法 - 不是重写"""
        print(f"{self.brand} {self.model} is honking")


class ElectricCar(Car):
    """电动汽车类 - 多级继承"""

    def __init__(self, brand, model, battery_capacity):
        super().__init__(brand, model)  # 重写 __init__ 方法
        self.battery_capacity = battery_capacity

    def start(self):  # 重写 start 方法
        """电动汽车启动"""
        print(f"Electric {self.brand} {self.model} is starting silently")

    def charge(self):
        """电动汽车特有的方法 - 不是重写"""
        print(f"Charging {self.brand} {self.model}")


# 使用示例
if __name__ == "__main__":
    dog = Dog("Buddy", "Golden Retriever")
    dog.speak()  # 调用重写的方法
    dog.move()   # 调用重写的方法
    dog.fetch()  # 调用特有方法

    cat = Cat("Whiskers")
    cat.speak()  # 调用重写的方法
    cat.eat()    # 调用继承的方法

    car = Car("Toyota", "Camry")
    car.start()  # 调用重写的方法
    car.stop()   # 调用继承的方法

    electric_car = ElectricCar("Tesla", "Model 3", "75kWh")
    electric_car.start()  # 调用重写的方法
    electric_car.charge()  # 调用特有方法
