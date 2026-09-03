import { ProjectTemplateEnum, ModuleTemplateEnum } from "../types/template";

export const ProjectTemplateData = [
  {
    label: "vite + vue + ts项目",
    value: ProjectTemplateEnum.ViteVueTs,
    path: "../template/project/vue/vite-vue-ts",
  },
];

export const ModuleTemplateData = [
  {
    label: "vue-ts的空模板",
    value: ModuleTemplateEnum.VueTsEmpty,
    path: "../template/module/vue/vue-ts-empty",
  },
];
