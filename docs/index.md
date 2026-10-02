<script setup>
import { withBase } from 'vitepress';
</script>

<div class="lab-home">

<section>
  <h1>Lab Word</h1>
  <p>实验室数字孪生，从设备模型的三维查看开始。</p>
  <p>Lab Viewer 与会话内资产库已接入正式应用。下一阶段的 Foundation v1 体验与实施规格已确认。</p>
  <p class="landing-actions">
    <a class="landing-button landing-button-primary" href="docs/">查看文档</a>
    <a class="landing-button" href="https://github.com/CaiZongyuan/labworld">GitHub 仓库</a>
  </p>
</section>

<section>
  <figure>
    <a :href="withBase('/lab-viewer-v1.png')"><img :src="withBase('/lab-viewer-v1.png')" alt="Lab Viewer v1 预览中的显微镜、三维画布和资产信息" width="1440" height="900" /></a>
    <figcaption>Lab Viewer v1 · 独立预览；账户与其他业务导航为模拟。</figcaption>
  </figure>
  <h2>当前工作</h2>
  <p>已支持预置设备、本地 GLB 导入、自动取景、相机操作、点击选择与渲染指标。持久布局、统一世界模型与后端虚拟设备按下一阶段规格实施。</p>
  <p><a href="guides/lab-viewer">查看设备模型</a> · <a href="architecture/lab-word">产品范围</a> · <a href="getting-started/quickstart">启动应用</a></p>
</section>

</div>
