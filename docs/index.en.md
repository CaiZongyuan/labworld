<script setup>
import { withBase } from 'vitepress';
</script>

<div class="lab-home">

<section>
  <h1>Lab Word</h1>
  <p>Laboratory digital twin, starting with a 3D equipment model viewer.</p>
  <p>The Lab Viewer v1 isolated preview is accepted. Application integration and validation are pending.</p>
  <p class="landing-actions">
    <a class="landing-button landing-button-primary" href="docs/">Documentation</a>
    <a class="landing-button" href="https://github.com/CaiZongyuan/labworld">GitHub repository</a>
  </p>
</section>

<section>
  <figure>
    <a :href="withBase('/lab-viewer-v1.png')"><img :src="withBase('/lab-viewer-v1.png')" alt="Microscope, 3D viewport and equipment information in the Lab Viewer v1 preview" width="1440" height="900" /></a>
    <figcaption>Lab Viewer v1 · isolated preview; identity and other business navigation are simulated.</figcaption>
  </figure>
  <h2>Current work</h2>
  <p>A preset model, local GLB import, automatic framing, camera controls, click selection and renderer metrics. Live equipment data and placement editing follow later.</p>
  <p><a href="guides/lab-viewer">Run the preview</a> · <a href="architecture/lab-word">Product scope</a> · <a href="getting-started/quickstart">Start the existing application</a></p>
</section>

</div>
