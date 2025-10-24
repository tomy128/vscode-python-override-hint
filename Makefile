# VS Code Extension Development Makefile

.PHONY: compile package publish clean install version-patch version-minor version-major

# 编译 TypeScript
compile:
	npm run compile

# 打包扩展
package:
	npm run compile && npx vsce package

# 发布到 VS Code Marketplace
publish:
	npx vsce publish

# 清理编译文件
clean:
	rm -rf out/
	rm -f *.vsix

# 安装依赖
install:
	npm install

# 本地安装扩展进行测试
install-local:
	code --install-extension python-override-hint-*.vsix

# 版本管理
version-patch:
	npm version patch
	@echo "请更新 CHANGELOG.md 中的版本信息"

version-minor:
	npm version minor
	@echo "请更新 CHANGELOG.md 中的版本信息"

version-major:
	npm version major
	@echo "请更新 CHANGELOG.md 中的版本信息"

# 发布新版本的完整流程
release-patch: version-patch package publish
	@echo "补丁版本发布完成"

release-minor: version-minor package publish
	@echo "次要版本发布完成"

release-major: version-major package publish
	@echo "主要版本发布完成"
