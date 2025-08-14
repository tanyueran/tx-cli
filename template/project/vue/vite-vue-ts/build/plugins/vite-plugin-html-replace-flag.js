import pkg from '../../package.json'

export function VitePluginHtmlReplaceFlag() {
  return {
    name: 'vite-plugin-html-replace-flag',
    transformIndexHtml(html) {
      // 添加版本号
      return html
        .replace(`version="%version%"`, `version="${pkg.version}"`)
        .replace(`build-time="%buildTime%"`, `build-time="${new Date().toLocaleString()}"`)
    },
  }
}
