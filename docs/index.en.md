<script setup>
import { withBase } from 'vitepress';
</script>

<div class="lab-home">

<section>
  <h1>Lab Word</h1>
  <p>Laboratory digital twin, starting with a 3D equipment model viewer.</p>
  <p>Lab Viewer and the session-local Asset Library are integrated. The next Foundation v1 experience and implementation spec are approved.</p>
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
  <p>The application supports a preset model, local GLB import, automatic framing, camera controls, click selection and renderer metrics. Persistent layouts, a shared world model and server-owned virtual devices are the next implementation stage.</p>
  <p><a href="guides/lab-viewer">View equipment models</a> · <a href="architecture/lab-word">Product scope</a> · <a href="getting-started/quickstart">Start the application</a></p>
</section>

</div>
