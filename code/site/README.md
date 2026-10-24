# Pipeline Factory 官网

纯静态单页站点，无构建步骤。`code/site/` 目录本身就是发布目录。

## 本地预览

在仓库根目录执行：

```bash
python3 -m http.server 4173 --directory code/site
```

打开 <http://127.0.0.1:4173/>。修改 HTML/CSS/JS 后刷新即可，不需要重新构建。

## 部署到 GitHub Pages

站点由 GitHub Actions 直接发布 `code/site/`，不走 Jekyll、也不需要把构建产物提交到另一个分支。

工作流：[`.github/workflows/pages.yml`](../../.github/workflows/pages.yml)

- 触发条件：推送到 `main` 且改动涉及 `code/site/**` 或工作流本身；也支持手动触发。
- 生产地址：<https://digitalmarsh.github.io/pipeline-factory/>

### 首次启用

仓库是 public 且 Actions 已启用，只差打开 Pages。二选一：

```bash
gh api -X POST repos/DigitalMarsh/pipeline-factory/pages -f build_type=workflow
```

或在 GitHub 仓库页面：Settings → Pages → Build and deployment → Source 选择 **GitHub Actions**。

启用后推送一次即可触发首次部署；也可以手动运行：

```bash
gh workflow run pages.yml
gh run list --workflow=pages.yml
```

### 注意事项

- 项目站点挂在 `/pipeline-factory/` 子路径下，因此 `index.html` 里必须使用相对路径
  （`styles.css`、`app.js`、`assets/...`），不要写成以 `/` 开头的绝对路径。
- GitHub Pages **不支持自定义响应头**。需要 COOP / Permissions-Policy 这类头时，得在前方加一层
  代理或 CDN。
- `.nojekyll` 用来避免 Jekyll 处理以下划线开头的文件；Actions 产物部署本来不跑 Jekyll，
  这个文件主要保护以后改回分支部署的情况。
- 换成自定义域名后，同步更新 `index.html` 的 canonical / OG URL、`robots.txt` 与 `sitemap.xml`。

## 目录

| 文件 | 作用 |
| --- | --- |
| `index.html` | 页面内容与结构 |
| `styles.css` | 视觉与响应式布局 |
| `app.js` | Run 动画、移动端导航、命令复制、导航高亮 |
| `assets/favicon.svg` | 站点图标 |
| `assets/og.png` | 社交分享图 |
| `.nojekyll` | 告诉 GitHub Pages 不要跑 Jekyll |
| `robots.txt` / `sitemap.xml` | 搜索引擎元数据 |

## 内容维护

页面里的版本号、安装命令与 GitHub 链接需要和发布物保持一致。升级发布物时，至少检查：

- `index.html` 中的 `pipeline-factory-0.2.0.tar.gz` 文件名；
- 前置条件（Node / Git 版本）；
- FAQ 中的错误码与处理方式。

修改 `styles.css` 或 `app.js` 后，把 `index.html` 里引用它们的 `?v=YYYYMMDD` 日期一起改掉，
避免浏览器继续使用缓存了一小时的旧资源。

产品能力的权威描述在仓库根目录的 `README.md` 与 `docs/INSTALL.md`；本页是面向使用者的摘要。
