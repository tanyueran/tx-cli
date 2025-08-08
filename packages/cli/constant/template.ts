import { ProjectTemplateEnum, ModuleTemplateEnum } from "../types/template";

export const ProjectTemplateData = [
  {
    label: "vite + vue + ts项目",
    value: ProjectTemplateEnum.ViteVueTs,
    path: "../packages/template/project/vue/vite-vue-ts",
  },
  {
    label: "webpack + vue + ts项目",
    value: ProjectTemplateEnum.WebpackVueTs,
    path: "../packages/template/project/vue/webpack-vue-ts",
  }
];

export const ModuleTemplateData = [
  {
    label: "vue-ts的页面模板",
    value: ModuleTemplateEnum.VueTsPageTemplate,
    path: "../template/module/vue/vue-ts-page-template",
  },
  {
    label: "vue-ts的详情模板",
    value: ModuleTemplateEnum.VueTsDetailTemplate,
    path: "../template/module/vue/vue-ts-detail-template",
  },
  {
    label: "vue-ts的空模板",
    value: ModuleTemplateEnum.VueTsEmpty,
    path: "../template/module/vue/vue-ts-empty",
  },
];
