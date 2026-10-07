/**
 * 模块职责：本仓库唯一的 ESLint 配置（flat config，ESLint 10 起只有这一种）。
 *
 * 三条范围约定，都是有意的：
 *
 *   1) **只检查 src 与 scripts，不碰 dist**。`packages/domain/dist` 是 tsc 的产物，检查它等于
 *      给同一份代码报两遍，而且报的位置在生成物里、改不了。
 *   2) **Node 与浏览器的全局变量按目录分开**。混在一起会让 `apps/api` 里写 `document`、
 *      或 `apps/web` 里写 `process` 都不报错——那正是这两类项目最容易犯的错，而它们各自都不会在
 *      运行时立刻炸。
 *   3) **Prettier 放在最后**（`eslint-config-prettier`）。它会关掉 ESLint 里所有与排版有关的规则；
 *      顺序反了，两者会对同一行给出互相矛盾的要求，`--fix` 变成来回改。
 *
 * 维护提示：**本配置刻意不启用需要类型信息的规则**（`recommendedTypeChecked`）。理由是本仓库
 *   `pnpm verify` 里已经跑了 `tsc --noEmit` 与 `vue-tsc --noEmit`，类型错误在那一步就拦住了；
 *   类型感知的 lint 会再跑一遍类型检查（慢很多），换来的主要是 `no-floating-promises` 这类
 *   "类型正确但语义可疑"的检查。要开就把下面那两行换成 `recommendedTypeChecked`，并给两个
 *   `languageOptions.parserOptions` 加 `projectService: true`——那时它是一个独立的决定，不是顺手的事。
 */
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import pluginVue from "eslint-plugin-vue";
import prettier from "eslint-config-prettier";
import globals from "globals";

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "**/coverage/**",
      // 配置与脚本本身按 Node 跑，规则同上；显式列出是为了让 `eslint .` 的范围一目了然。
      "**/*.sqlite",
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  // ── 后端与领域层：Node 运行时 ────────────────────────────────────────────
  {
    files: ["packages/**/*.ts", "apps/api/**/*.ts", "scripts/**/*.js", "scripts/**/*.mjs", "*.js"],
    languageOptions: {
      globals: { ...globals.node },
      parserOptions: { sourceType: "module" },
    },
  },

  // ── 前端：浏览器运行时，且要认 .vue ──────────────────────────────────────
  {
    files: ["apps/web/**/*.ts"],
    languageOptions: {
      globals: { ...globals.browser },
      parserOptions: { sourceType: "module" },
    },
  },
  /**
   * Vue 插件只挂在 `.vue` 上，**不是整个 web 目录**。
   *
   * `flat/recommended` 里那几条（`one-component-per-file`、`component-definition-name-casing`、
   * `require-default-prop`）说的是**单文件组件**的形状；而本仓库的 `.ts` 里唯一会出现组件的地方是
   * 测试用的 `defineComponent` 桩件（一个文件里给 ElDialog / ElButton / ElTag 各造一个）。对它们
   * 套 SFC 规则只会报出 53 条与实际风险无关的噪声，把真正的信号淹掉。
   */
  ...pluginVue.configs["flat/recommended"].map((config) => ({ ...config, files: ["apps/web/**/*.vue"] })),
  {
    files: ["apps/web/**/*.vue"],
    languageOptions: {
      globals: { ...globals.browser },
      parserOptions: {
        // 链式解析：先让 vue-eslint-parser 拆 SFC，再把 <script> 交给 TS 解析器。
        parser: tseslint.parser,
        extraFileExtensions: [".vue"],
        sourceType: "module",
      },
    },
    rules: {
      /**
       * 本仓库的 SFC 全是 `<script setup lang="ts">`：可选的 prop 已经由类型说清楚了
       * （`project?: Project`），再加一个 JS 层的 `default` 只是把同一件事写两遍，而 `default:
       * undefined` 那种写法在模板里读起来比类型还绕。这条规则的目标是**没有类型**的那类 SFC。
       */
      "vue/require-default-prop": "off",
    },
  },

  {
    rules: {
      // 未使用的参数：允许用前置下划线显式表达"这个位置我不用但必须占住"（回调签名、解构占位）。
      // 关掉整条的代价是漏掉真的忘删的变量，所以只开这个逃生口而不是把规则整个关掉。
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" }],
    },
  },

  prettier,
);
