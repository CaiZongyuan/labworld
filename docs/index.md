<script setup>
import { withBase } from 'vitepress';
</script>

<div class="lab-home">

<section>
  <h1>Lab Word</h1>
  <p>实验室数字孪生，从设备模型的三维查看开始。</p>
  <p>Foundation V1 已实现持久资产、Lab 与布局。Member 和 Agent 共用后端虚拟设备、观测、任务和历史。</p>
  <p class="landing-actions">
    <a class="landing-button landing-button-primary" href="docs/">查看文档</a>
    <a class="landing-button" href="https://github.com/CaiZongyuan/labworld">GitHub 仓库</a>
  </p>
</section>

<section>
  <figure>
    <a :href="withBase('/lab-foundation-v1.png')"><img :src="withBase('/lab-foundation-v1.png')" alt="正式 Foundation V1 的对象目录、导入模型、多节点视口、照明 Inspector 和运行历史" width="1440" height="1000" /></a>
    <figcaption>Foundation V1 · 真实应用栈；可复现的开发数据与内置虚拟设备。版本：c6c3063 加完整旅程交付。</figcaption>
  </figure>
  <h2>当前工作</h2>
  <p>用户可以导入持久 GLB、登记独立对象、编辑布局、运行设备、查询结果并归档。完整学习路径和独立参考负载入口已提供。真实协议和机器人控制仍属后续范围。</p>
  <p><a href="tutorials/complete-foundation">完成数字实验室旅程</a> · <a href="architecture/lab-word">产品范围</a> · <a href="getting-started/quickstart">启动应用</a></p>
</section>

</div>
