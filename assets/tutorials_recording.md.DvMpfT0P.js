import{_ as n,o as a,c as e,a3 as i}from"./chunks/framework.DVCfY5-a.js";const g=JSON.parse('{"title":"采集和检查一次 Lab Recording","description":"","frontmatter":{"docLocale":"zh","counterpart":"/en/tutorials/recording","contentType":"tutorial","prev":{"text":"安装固定场景并管理仿真会话","link":"/tutorials/simulation-session"},"next":{"text":"固定 Newton 环境并观察 SO-101","link":"/tutorials/newton-motion"}},"headers":[],"relativePath":"tutorials/recording.md","filePath":"tutorials/recording.md"}'),p={name:"tutorials/recording.md"};function t(l,s,r,o,c,d){return a(),e("div",null,[...s[0]||(s[0]=[i(`<h1 id="采集和检查一次-lab-recording" tabindex="-1">采集和检查一次 Lab Recording <a class="header-anchor" href="#采集和检查一次-lab-recording" aria-label="Permalink to &quot;采集和检查一次 Lab Recording&quot;">​</a></h1><p>目标：运行一次 Simulation Session，读取它的初始条件、可靠运动片段和事件，再检查完整性并独立删除录制。</p><p>先完成<a href="./simulation-session">固定场景与仿真会话</a>。保留该章的 <code>Shared Session</code> Lab、Installation、GLB 资产和开发数据目录。使用仓库指定的 Node、pnpm，以及安装了固定 <code>websockets</code> 依赖的 Python 环境。以下 Bash 命令从仓库根目录运行。本章使用 Synthetic 开发来源，不需要 Newton、GPU 或 Docker。</p><h2 id="采集一次运行" tabindex="-1">采集一次运行 <a class="header-anchor" href="#采集一次运行" aria-label="Permalink to &quot;采集一次运行&quot;">​</a></h2><p>如果前一章的服务已停止，用相同目录启动：</p><div class="language-bash vp-adaptive-theme"><button title="Copy Code" class="copy"></button><span class="lang">bash</span><pre class="shiki shiki-themes github-light github-dark vp-code" tabindex="0"><code><span class="line"><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8;">LAB_WORD_SYNTHETIC_SESSION</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583;">=</span><span style="--shiki-light:#032F62;--shiki-dark:#9ECBFF;">true</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8;"> LAB_WORD_SYNTHETIC_PYTHON</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583;">=</span><span style="--shiki-light:#032F62;--shiki-dark:#9ECBFF;">&quot;</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8;">$PWD</span><span style="--shiki-light:#032F62;--shiki-dark:#9ECBFF;">/.scratch/session-python/bin/python&quot;</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8;"> LAB_WORD_DATA_DIR</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583;">=</span><span style="--shiki-light:#032F62;--shiki-dark:#9ECBFF;">.scratch/session-tutorial-data</span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0;"> pnpm</span><span style="--shiki-light:#032F62;--shiki-dark:#9ECBFF;"> dev</span></span></code></pre></div><ol><li>打开 <a href="http://127.0.0.1:5173/lab" target="_blank" rel="noreferrer">http://127.0.0.1:5173/lab</a>，以普通 Member 登录。</li><li>打开 <code>Shared Session</code> Lab 和<strong>仿真会话</strong>。</li><li>选择原 Installation，点击 <strong>Start</strong>。</li><li>等待<strong>正在运行</strong>和<strong>运动已连接</strong>。</li><li>点击 <strong>Pause</strong>，等待已暂停。</li><li>等待数秒，再点击 <strong>Resume</strong>。</li><li>等待运行数秒，点击 <strong>Stop</strong>，等待已停止。</li></ol><p>Start 自动创建一份 Recording。服务先保存并同步初始条件，再接受可靠来源的版本头和第一帧。正在运行表示初始可靠采集和实时运动都已通过准入。它不表示机器人任务成功。</p><p>来源在选定采样处保留每个完整运动帧，再交给直播发送槽。直播可以覆盖较旧的待发送帧。没有 Viewer、Viewer 离开或较慢时，Recording 仍保留每个选定采样。这里的选定采样不等于每个物理求解步。</p><h2 id="读取录制和实际片段" tabindex="-1">读取录制和实际片段 <a class="header-anchor" href="#读取录制和实际片段" aria-label="Permalink to &quot;读取录制和实际片段&quot;">​</a></h2><p>在已登录 Lab 页面的浏览器 Console 中运行：</p><div class="language-js vp-adaptive-theme"><button title="Copy Code" class="copy"></button><span class="lang">js</span><pre class="shiki shiki-themes github-light github-dark vp-code" tabindex="0"><code><span class="line"><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8;">(</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583;">await</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8;"> (</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583;">await</span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0;"> fetch</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8;">(</span><span style="--shiki-light:#032F62;--shiki-dark:#9ECBFF;">&#39;/api/v1/lab/labs&#39;</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8;">)).</span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0;">json</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8;">()).data.</span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0;">map</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8;">(({ </span><span style="--shiki-light:#E36209;--shiki-dark:#FFAB70;">id</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8;">, </span><span style="--shiki-light:#E36209;--shiki-dark:#FFAB70;">name</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8;"> }) </span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583;">=&gt;</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8;"> ({</span></span>
<span class="line"><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8;">  id,</span></span>
<span class="line"><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8;">  name,</span></span>
<span class="line"><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8;">}));</span></span></code></pre></div><p>把 <code>Shared Session</code> 的 UUID 替换到下面的请求中。它读取有界的第一页，不改变 Lab：</p><div class="language-js vp-adaptive-theme"><button title="Copy Code" class="copy"></button><span class="lang">js</span><pre class="shiki shiki-themes github-light github-dark vp-code" tabindex="0"><code><span class="line"><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8;">(</span></span>
<span class="line"><span style="--shiki-light:#D73A49;--shiki-dark:#F97583;">  await</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8;"> (</span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583;">await</span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0;"> fetch</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8;">(</span><span style="--shiki-light:#032F62;--shiki-dark:#9ECBFF;">&#39;/api/v1/lab/labs/&lt;lab-uuid&gt;/recordings?limit=5&#39;</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8;">)).</span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0;">json</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8;">()</span></span>
<span class="line"><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8;">).data.</span><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0;">map</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8;">(({ </span><span style="--shiki-light:#E36209;--shiki-dark:#FFAB70;">id</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8;">, </span><span style="--shiki-light:#E36209;--shiki-dark:#FFAB70;">session_id</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8;">, </span><span style="--shiki-light:#E36209;--shiki-dark:#FFAB70;">status</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8;">, </span><span style="--shiki-light:#E36209;--shiki-dark:#FFAB70;">integrity</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8;">, </span><span style="--shiki-light:#E36209;--shiki-dark:#FFAB70;">reason</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8;"> }) </span><span style="--shiki-light:#D73A49;--shiki-dark:#F97583;">=&gt;</span><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8;"> ({</span></span>
<span class="line"><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8;">  id,</span></span>
<span class="line"><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8;">  session_id,</span></span>
<span class="line"><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8;">  status,</span></span>
<span class="line"><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8;">  integrity,</span></span>
<span class="line"><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8;">  reason,</span></span>
<span class="line"><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8;">}));</span></span></code></pre></div><p>找到刚结束的 Session 对应的 Recording UUID。将下面的完整示例粘贴到 Console：</p><div class="language-text vp-adaptive-theme"><button title="Copy Code" class="copy"></button><span class="lang">text</span><pre class="shiki shiki-themes github-light github-dark vp-code" tabindex="0"><code><span class="line"><span>// Paste into the Console of the authenticated, same-origin Lab page.</span></span>
<span class="line"><span>// These functions read bounded pages and one sealed segment. Delete is a separate explicit call.</span></span>
<span class="line"><span>const recordingUUID = (value) =&gt; {</span></span>
<span class="line"><span>  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(value))</span></span>
<span class="line"><span>    throw new Error(&#39;Use a Lab or Recording UUID.&#39;);</span></span>
<span class="line"><span>  return value;</span></span>
<span class="line"><span>};</span></span>
<span class="line"><span>const recordingHash = async (bytes) =&gt;</span></span>
<span class="line"><span>  &#39;sha256:&#39; +</span></span>
<span class="line"><span>  Array.from(</span></span>
<span class="line"><span>    new Uint8Array(await crypto.subtle.digest(&#39;SHA-256&#39;, bytes)),</span></span>
<span class="line"><span>    (byte) =&gt; byte.toString(16).padStart(2, &#39;0&#39;),</span></span>
<span class="line"><span>  ).join(&#39;&#39;);</span></span>
<span class="line"><span>async function recordingReadBytes(response, maximum) {</span></span>
<span class="line"><span>  if (!response.ok)</span></span>
<span class="line"><span>    throw new Error(\`Recording request failed: \${response.status}\`);</span></span>
<span class="line"><span>  if (!response.body) throw new Error(&#39;Recording response has no body.&#39;);</span></span>
<span class="line"><span>  const reader = response.body.getReader();</span></span>
<span class="line"><span>  const chunks = [];</span></span>
<span class="line"><span>  let size = 0;</span></span>
<span class="line"><span>  try {</span></span>
<span class="line"><span>    while (true) {</span></span>
<span class="line"><span>      const { value, done } = await reader.read();</span></span>
<span class="line"><span>      if (done) break;</span></span>
<span class="line"><span>      if (value.byteLength &gt; maximum - size)</span></span>
<span class="line"><span>        throw new Error(&#39;Recording response exceeds its read limit.&#39;);</span></span>
<span class="line"><span>      size += value.byteLength;</span></span>
<span class="line"><span>      chunks.push(value);</span></span>
<span class="line"><span>    }</span></span>
<span class="line"><span>    const result = new Uint8Array(size);</span></span>
<span class="line"><span>    let offset = 0;</span></span>
<span class="line"><span>    for (const chunk of chunks) {</span></span>
<span class="line"><span>      result.set(chunk, offset);</span></span>
<span class="line"><span>      offset += chunk.byteLength;</span></span>
<span class="line"><span>    }</span></span>
<span class="line"><span>    return result;</span></span>
<span class="line"><span>  } finally {</span></span>
<span class="line"><span>    await reader.cancel().catch(() =&gt; {});</span></span>
<span class="line"><span>    reader.releaseLock();</span></span>
<span class="line"><span>  }</span></span>
<span class="line"><span>}</span></span>
<span class="line"><span></span></span>
<span class="line"><span>globalThis.inspectRecording = async function inspectRecording(</span></span>
<span class="line"><span>  labId,</span></span>
<span class="line"><span>  recordingId,</span></span>
<span class="line"><span>  eventsCursor = null,</span></span>
<span class="line"><span>) {</span></span>
<span class="line"><span>  const path = \`/api/v1/lab/labs/\${recordingUUID(labId)}/recordings/\${recordingUUID(recordingId)}\`;</span></span>
<span class="line"><span>  const read = async (suffix, maximum = 256 * 1024) =&gt;</span></span>
<span class="line"><span>    JSON.parse(</span></span>
<span class="line"><span>      new TextDecoder(&#39;utf-8&#39;, { fatal: true }).decode(</span></span>
<span class="line"><span>        await recordingReadBytes(await fetch(path + suffix), maximum),</span></span>
<span class="line"><span>      ),</span></span>
<span class="line"><span>    );</span></span>
<span class="line"><span>  const metadata = await read(&#39;&#39;);</span></span>
<span class="line"><span>  const manifest = await read(&#39;/manifest&#39;, 2 * 1024 * 1024);</span></span>
<span class="line"><span>  const segments = await read(&#39;/segments?limit=5&#39;);</span></span>
<span class="line"><span>  const events = await read(</span></span>
<span class="line"><span>    &#39;/events?limit=5&#39; +</span></span>
<span class="line"><span>      (eventsCursor ? &#39;&amp;cursor=&#39; + encodeURIComponent(eventsCursor) : &#39;&#39;),</span></span>
<span class="line"><span>  );</span></span>
<span class="line"><span>  const segment = segments.data.find((item) =&gt; item.sealed);</span></span>
<span class="line"><span>  const records = [];</span></span>
<span class="line"><span>  if (segment) {</span></span>
<span class="line"><span>    if (</span></span>
<span class="line"><span>      !Number.isInteger(segment.size) ||</span></span>
<span class="line"><span>      segment.size &lt; 36 ||</span></span>
<span class="line"><span>      segment.size &gt; 1024 * 1024</span></span>
<span class="line"><span>    )</span></span>
<span class="line"><span>      throw new Error(&#39;Select a sealed segment within the 1 MiB read limit.&#39;);</span></span>
<span class="line"><span>    const bytes = await recordingReadBytes(</span></span>
<span class="line"><span>      await fetch(path + \`/segments/\${segment.id}\`),</span></span>
<span class="line"><span>      segment.size,</span></span>
<span class="line"><span>    );</span></span>
<span class="line"><span>    if (</span></span>
<span class="line"><span>      bytes.byteLength !== segment.size ||</span></span>
<span class="line"><span>      (await recordingHash(bytes)) !== segment.sha256</span></span>
<span class="line"><span>    )</span></span>
<span class="line"><span>      throw new Error(&#39;Segment bytes do not match their size and SHA-256.&#39;);</span></span>
<span class="line"><span>    // LWF record: u32 little-endian JSON length, 32-byte SHA-256, exact UTF-8 JSON.</span></span>
<span class="line"><span>    let offset = 0;</span></span>
<span class="line"><span>    while (offset &lt; bytes.byteLength &amp;&amp; records.length &lt; 16) {</span></span>
<span class="line"><span>      if (bytes.byteLength - offset &lt; 36)</span></span>
<span class="line"><span>        throw new Error(&#39;Truncated segment record.&#39;);</span></span>
<span class="line"><span>      const size = new DataView(bytes.buffer).getUint32(offset, true);</span></span>
<span class="line"><span>      if (</span></span>
<span class="line"><span>        size &lt; 1 ||</span></span>
<span class="line"><span>        size &gt; 128 * 1024 ||</span></span>
<span class="line"><span>        size &gt; bytes.byteLength - offset - 36</span></span>
<span class="line"><span>      )</span></span>
<span class="line"><span>        throw new Error(&#39;Invalid segment record.&#39;);</span></span>
<span class="line"><span>      const payload = bytes.subarray(offset + 36, offset + 36 + size);</span></span>
<span class="line"><span>      const expected =</span></span>
<span class="line"><span>        &#39;sha256:&#39; +</span></span>
<span class="line"><span>        Array.from(bytes.subarray(offset + 4, offset + 36), (byte) =&gt;</span></span>
<span class="line"><span>          byte.toString(16).padStart(2, &#39;0&#39;),</span></span>
<span class="line"><span>        ).join(&#39;&#39;);</span></span>
<span class="line"><span>      if ((await recordingHash(payload)) !== expected)</span></span>
<span class="line"><span>        throw new Error(&#39;Record SHA-256 does not match.&#39;);</span></span>
<span class="line"><span>      records.push(</span></span>
<span class="line"><span>        JSON.parse(new TextDecoder(&#39;utf-8&#39;, { fatal: true }).decode(payload)),</span></span>
<span class="line"><span>      );</span></span>
<span class="line"><span>      offset += 36 + size;</span></span>
<span class="line"><span>    }</span></span>
<span class="line"><span>  }</span></span>
<span class="line"><span>  const result = {</span></span>
<span class="line"><span>    recording_id: metadata.id,</span></span>
<span class="line"><span>    session_id: metadata.session_id,</span></span>
<span class="line"><span>    status: metadata.status,</span></span>
<span class="line"><span>    integrity: metadata.integrity,</span></span>
<span class="line"><span>    reason: metadata.reason,</span></span>
<span class="line"><span>    prefix: metadata.prefix,</span></span>
<span class="line"><span>    manifest: {</span></span>
<span class="line"><span>      snapshot_hash: manifest.snapshot_hash,</span></span>
<span class="line"><span>      captured_entities: manifest.capture_entity_ids.length,</span></span>
<span class="line"><span>      physics_entities: manifest.physics_entity_ids.length,</span></span>
<span class="line"><span>      versions: manifest.versions,</span></span>
<span class="line"><span>    },</span></span>
<span class="line"><span>    segments: segments.data,</span></span>
<span class="line"><span>    next_segments_cursor: segments.next_cursor,</span></span>
<span class="line"><span>    events: events.data,</span></span>
<span class="line"><span>    next_events_cursor: events.next_cursor,</span></span>
<span class="line"><span>    verified_segment_id: segment?.id ?? null,</span></span>
<span class="line"><span>    first_record: records[0] ?? null,</span></span>
<span class="line"><span>    source_header:</span></span>
<span class="line"><span>      records.find((record) =&gt; record.kind === &#39;source.header&#39;)?.data</span></span>
<span class="line"><span>        .source_header ?? null,</span></span>
<span class="line"><span>    inspected_records: records.map(({ ordinal, kind }) =&gt; ({ ordinal, kind })),</span></span>
<span class="line"><span>  };</span></span>
<span class="line"><span>  console.log(result);</span></span>
<span class="line"><span>  return result;</span></span>
<span class="line"><span>};</span></span>
<span class="line"><span></span></span>
<span class="line"><span>globalThis.deleteRecording = async function deleteRecording(</span></span>
<span class="line"><span>  labId,</span></span>
<span class="line"><span>  recordingId,</span></span>
<span class="line"><span>) {</span></span>
<span class="line"><span>  const identity = await fetch(&#39;/api/v1/auth/session&#39;);</span></span>
<span class="line"><span>  if (!identity.ok) throw new Error(&#39;Sign in before deleting a Recording.&#39;);</span></span>
<span class="line"><span>  const { csrf_token: csrf } = await identity.json();</span></span>
<span class="line"><span>  const path = \`/api/v1/lab/labs/\${recordingUUID(labId)}/recordings/\${recordingUUID(recordingId)}\`;</span></span>
<span class="line"><span>  const response = await fetch(path, {</span></span>
<span class="line"><span>    method: &#39;DELETE&#39;,</span></span>
<span class="line"><span>    headers: { &#39;x-csrf-token&#39;: csrf },</span></span>
<span class="line"><span>  });</span></span>
<span class="line"><span>  if (!response.ok)</span></span>
<span class="line"><span>    throw new Error(\`Recording deletion refused: \${response.status}\`);</span></span>
<span class="line"><span>  console.log({ deleted_recording_id: recordingId, status: response.status });</span></span>
<span class="line"><span>};</span></span></code></pre></div><p>运行 <code>await inspectRecording(&#39;&lt;lab-uuid&gt;&#39;, &#39;&lt;recording-uuid&gt;&#39;)</code>。</p><p>预期结果包含 Recording 和 Session 身份、<code>status</code>、<code>integrity</code>、<code>reason</code>、可靠 <code>prefix</code>、版本摘要、片段及事件第一页。正常 Stop 完成后，<code>status</code> 和 <code>integrity</code> 为 <code>complete</code>，<code>prefix.source_ended</code> 为 <code>true</code>。如果仍在完成最后片段，稍后重新读取。不要把暂时的 <code>open</code> 当作已完成。</p><p>示例最多读取五项片段和五项事件，并读取其中一个已封存片段。它检查该片段的字节数和 SHA-256，再核对最前面的最多 16 个 LWF 记录。<code>first_record</code> 通常是启动头。<code>source_header</code> 显示这些记录中已接受的来源版本头。它为 null 时，需要继续检查后续记录，不能推断依赖版本。<code>verified_segment_id</code> 为 null 时，该页还没有已封存片段；Stop 后重新读取。</p><p>片段是原始事实容器。每个 LWF 记录包含小端 u32 JSON 长度、32 字节 SHA-256 和 UTF-8 JSON。<code>source.packet</code> 记录中的 <code>packet_base64</code> 保存原始 LWR1 字节；运动批次保留原始 LWM1 帧。这些字节可独立核对，不用 Gateway 的最新帧推断录制内容。</p><h2 id="理解时间和完整性" tabindex="-1">理解时间和完整性 <a class="header-anchor" href="#理解时间和完整性" aria-label="Permalink to &quot;理解时间和完整性&quot;">​</a></h2><table tabindex="0"><thead><tr><th>字段</th><th>如何读取</th></tr></thead><tbody><tr><td><code>snapshot_hash</code>、<code>manifest_sha256</code></td><td>当次固定快照和清单的身份。当前布局与资产更新不会改写它们。</td></tr><tr><td><code>capture_baseline</code></td><td>采集开始时普通设备的实际状态、在途 Command 和时间。Reset 保留原物理快照，并另存当前基线。</td></tr><tr><td><code>versions</code>、<code>source.header</code></td><td>服务版本与来源报告的代码、Python、依赖版本。未知值保持 null；来源报告不是独立的安装证明。</td></tr><tr><td><code>recorded_at</code></td><td>服务记录事实的真实时间。普通设备的时间在物理 Pause 期间继续。</td></tr><tr><td><code>sim_time_ns</code></td><td>来源的仿真时间，使用十进制字符串。普通 Device Program 事件为 null。</td></tr><tr><td><code>prefix</code></td><td>已同步确认的连续来源前缀。运动序号、来源事件序号和全局记录 ordinal 各有含义。</td></tr><tr><td><code>incomplete</code>、<code>reason</code></td><td>只保证已保留的有效事实。未确认的尾部可能未知，不能把它解释为没有活动。</td></tr></tbody></table><p>Pause 和 Resume 各保存一个新边界帧及 <code>lifecycle.applied</code> 事件。Resume 边界可以与 Pause 边界具有相同仿真时间，但序号递增。Stop 还保存最终来源序号与来源结束事实。完成状态还要求服务器事件和最终片段已保存。</p><p>Reset 结束旧 Session 和 Recording，再创建两个新身份。新来源从仿真时间零开始。旧 Recording 的时间不倒退。普通 Device Program Run 保留自己的实时行为；物理 Pause、Reset 或 Stop 不替它停止任务。</p><p><code>capture_entity_ids</code> 固定当次 World 的对象集合。<code>physics_entity_ids</code> 只包含 Installation 的物理绑定对象。后来创建的 Entity 不加入这份旧录制。缺少属性的先前值仍为未知。</p><p>可靠 ACK 只确认已完成文件同步的连续来源事实。网络发送完成、实时帧接收和动作已执行是不同确认。缓存或存储容量不足、写入失败、确认超时及来源异常都会停止或中断 Session，并保留明确的不完整状态。不会自动重放动作。</p><h2 id="分页和-sdk" tabindex="-1">分页和 SDK <a class="header-anchor" href="#分页和-sdk" aria-label="Permalink to &quot;分页和 SDK&quot;">​</a></h2><p>以下读取都要求同一个 Lab 的有效 Member 身份，或具有 <code>lab:full</code> 的 Agent key：</p><table tabindex="0"><thead><tr><th>方法和路径后缀</th><th>结果</th></tr></thead><tbody><tr><td><code>GET /recordings</code></td><td>Recording 元数据页。</td></tr><tr><td><code>GET /recordings/{recording_id}</code></td><td>一个 Recording 的元数据和完整性。</td></tr><tr><td><code>GET /recordings/{recording_id}/manifest</code></td><td>固定快照、当前采集基线、对象集合和版本清单。</td></tr><tr><td><code>GET /recordings/{recording_id}/segments</code></td><td>片段元数据页。</td></tr><tr><td><code>GET /recordings/{recording_id}/segments/{segment_id}</code></td><td>一个片段的实际字节。</td></tr><tr><td><code>GET /recordings/{recording_id}/events</code></td><td>已确认事件页。</td></tr></tbody></table><p>这些后缀都位于 <code>/api/v1/lab/labs/{lab_id}</code> 下。列表 <code>limit</code> 默认为 20，允许 1 到 100。事件页还受 256 KiB 预算约束。保留 <code>next_cursor</code>，将它作为 <code>cursor</code> 传入同一列表的下一次请求。片段和事件游标绑定当前 Recording。改变 Lab、Recording 或筛选时，从第一页重新读取。</p><p>事件查询每次只扫描一个最多 1 MiB 的已确认片段；旧式提交需要回查时，另读最多两个精确片段。只有 pose 的历史可能返回空 <code>data</code> 和非空 <code>next_cursor</code>。继续同一游标链，直到 <code>next_cursor</code> 为 null；空数据不是结束。开放录制按本次已确认前缀读取，后续追加可从保留的游标继续。示例的第三个参数接受上次的事件游标。</p><p>新事件游标经过独立的 Lab 密钥签名，正常服务重启后仍可使用。备份不包含密钥；恢复到新数据目录后从第一页重新查询，原录制历史不变。</p><p>生成 SDK 提供相同的列表和读取方法。<a href="https://github.com/CaiZongyuan/labworld/blob/bb30302126c39bfac561ae63dc395c2bf2195b1b/packages/sdk/src/recording.ts" target="_blank" rel="noreferrer">readRecordingSegment</a> 读取并核对一个已封存片段，最多 1 MiB。调用者持有 AbortSignal，并决定何时替换当前页。不要将整个 Recording 的片段合并到内存中。</p><h2 id="独立删除" tabindex="-1">独立删除 <a class="header-anchor" href="#独立删除" aria-label="Permalink to &quot;独立删除&quot;">​</a></h2><ol><li>使用相同 Installation 再 Start、运行数秒并 Stop，得到 Recording B。</li><li>读取 A 和 B。确认它们有不同 Recording、Session 身份，并引用同一固定 GLB 版本。</li><li>保存 B 的一个已封存片段身份和 SHA-256。</li><li>显式运行 <code>await deleteRecording(&#39;&lt;lab-uuid&gt;&#39;, &#39;&lt;recording-a-uuid&gt;&#39;)</code>。</li><li>重新查询 Recording 列表，确认 A 已移除。</li><li>再运行 <code>inspectRecording</code> 读取 B，确认其原片段和 SHA-256 仍可读取。</li></ol><p>删除是持久操作。该函数使用当前 Member 的 CSRF token。活动 Recording 返回 409；先 Stop，再显式删除。无效身份返回 401，缺少权限或 CSRF 返回 403，跨 Lab 或不存在的身份返回 404。取得有效身份后，重新执行你的明确请求。</p><p>Recording 持有自己的精确资源引用。删除 A 只释放 A 的引用。B、当前资产或其他消费者仍引用的文件保留。普通设备历史清理也不删除这些 Recording 事实。</p><h2 id="制造一次隔离的写入失败" tabindex="-1">制造一次隔离的写入失败 <a class="header-anchor" href="#制造一次隔离的写入失败" aria-label="Permalink to &quot;制造一次隔离的写入失败&quot;">​</a></h2><p>从仓库根目录运行这个真实进程合同案例：</p><div class="language-bash vp-adaptive-theme"><button title="Copy Code" class="copy"></button><span class="lang">bash</span><pre class="shiki shiki-themes github-light github-dark vp-code" tabindex="0"><code><span class="line"><span style="--shiki-light:#6F42C1;--shiki-dark:#B392F0;">node</span><span style="--shiki-light:#005CC5;--shiki-dark:#79B8FF;"> --test</span><span style="--shiki-light:#005CC5;--shiki-dark:#79B8FF;"> --test-concurrency=1</span><span style="--shiki-light:#005CC5;--shiki-dark:#79B8FF;"> --experimental-strip-types</span><span style="--shiki-light:#005CC5;--shiki-dark:#79B8FF;"> --test-name-pattern=</span><span style="--shiki-light:#032F62;--shiki-dark:#9ECBFF;">&#39;recording write failure&#39;</span><span style="--shiki-light:#032F62;--shiki-dark:#9ECBFF;"> tests/e2e/recording-reliability.test.ts</span></span></code></pre></div><p>先运行过 <code>pnpm install --frozen-lockfile</code>，并使用仓库指定的 Node 版本。此案例不需要 Python、GPU 或正在运行的教程服务。它创建自己的临时数据目录、loopback 服务和经鉴权的 Machine 来源。</p><p>案例先发送并保存外部已确认的 t0 字节。然后通过测试进程的 IPC，在下一次 <code>source.packet</code> 文件写入前触发一次失败。它再次发送一个选定运动帧，并从正式 API 检查结果。</p><p>预期 Node 测试通过，并输出非敏感的 <code>recording-write-failure</code> 回执。下一帧没有耐久 ACK。Session 中断，Recording 为 incomplete，原因标明写入失败。原来已经确认的完整 t0 字节仍可通过片段接口读取。案例清理自己的进程、socket 和临时数据目录，并核对 ownership ledger。</p><p>IPC 故障只在该隔离测试进程中生效。教程数据保持原样。</p><p>来源崩溃或服务进程被强杀后，重新打开相同数据目录会保留可校验的有效片段，并中断旧 Session。未确认的尾部可以未知。耐久范围覆盖实际来源和服务进程终止、同步及重开检查；没有测试操作系统崩溃或断电保证。重新开始需要显式创建新 Session。</p><h2 id="结束" tabindex="-1">结束 <a class="header-anchor" href="#结束" aria-label="Permalink to &quot;结束&quot;">​</a></h2><p>Stop 活动 Session，关闭 Viewer，再用 Ctrl+C 停止开发服务。监管器释放自己的 Python 来源、两条 socket 和定时器。保留 <code>.scratch/session-tutorial-data</code> 和 Python 环境，或在确认没有消费者后独立移除它们。</p><p>查看<a href="./lab-records">Lab 运行记录</a>了解普通历史的查询与保留策略。Recording 查询表达当次已保存的事实；Replay、外部渲染、远程 Newton 和物理任务仍是后续工作。</p><hr><p>源码版本：<code>bb30302126c3</code> · <a href="https://github.com/CaiZongyuan/labworld/blob/bb30302126c39bfac561ae63dc395c2bf2195b1b/docs/tutorials/recording.md" target="_blank" rel="noreferrer">本页 Markdown</a></p>`,50)])])}const k=n(p,[["render",t]]);export{g as __pageData,k as default};
