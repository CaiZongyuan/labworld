<script setup>
import { withBase } from 'vitepress';
</script>

<div class="lab-home">

<section>
  <h1>Lab Word</h1>
  <p>Laboratory digital twin, starting with a 3D equipment model viewer.</p>
  <p>Foundation V1 provides persistent assets, Labs and layouts. Members and Agents share backend virtual devices, observations, Tasks and history.</p>
  <p class="landing-actions">
    <a class="landing-button landing-button-primary" href="docs/">Documentation</a>
    <a class="landing-button" href="https://github.com/CaiZongyuan/labworld">GitHub repository</a>
  </p>
</section>

<section>
  <figure>
    <a :href="withBase('/lab-foundation-v1.png')"><img :src="withBase('/lab-foundation-v1.png')" alt="Production Foundation V1 with an object directory, imported model, multi-node viewport, lighting Inspector and run history" width="1440" height="1000" /></a>
    <figcaption>Foundation V1 · real application stack; reproducible development data and built-in virtual devices. Version: c6c3063 plus the complete journey.</figcaption>
  </figure>
  <h2>Current work</h2>
  <p>Users can import persistent GLBs, register independent objects, edit layouts, run devices, query results and archive Entities. The complete learning path includes a separate reference-load command. Physical protocols and robot control remain future scope.</p>
  <p><a href="tutorials/complete-foundation">Complete the laboratory journey</a> · <a href="architecture/lab-word">Product scope</a> · <a href="getting-started/quickstart">Start the application</a></p>
</section>

</div>
