// The knowledge example's bilingual message catalog (docs/ui/design.md §6
// Q1): every fixed string the example renders, in both locales. Keys are
// bare here; assembly namespaces them under `knowledge.` and requires
// zh/en parity, so a key missing in either locale fails the assembly.
// zh texts are the historical wording of these views; en is the second
// locale, not a transliteration — operation names keep their established
// product terms (document, knowledge base, grant, export).

type Catalog = Record<string, string>;

const zh: Catalog = {
  // Shared across the example's views.
  'common.newDocument': '新建文档',
  'common.saving': '正在保存…',
  'common.downloading': '正在下载…',
  'common.readingSession': '正在读取会话…',
  'common.version': '版本 {version}',
  'common.cancel': '取消',
  'errors.unauthorized': '会话已失效，请重新登录。',
  'errors.docAccessLost': '文档不存在或访问权限已失效。',
  'errors.actionIncomplete': '操作未完成',
  'errors.requestId': '请求编号：{id}',
  'errors.fallback': '服务暂时不可用，请稍后重试。',

  // Documents: list, search, editor, reader.
  'errors.writeForbidden': '没有写入权限，请联系企业管理员。',
  'errors.docNotFound': '文档不存在，或你已失去访问权限。',
  'errors.invalidSearch': '搜索词最多 200 个字符，且不能包含无效字符。',
  'errors.invalidPage': '分页已失效，请重新查询。',
  'errors.invalidTitle': '请填写不超过 200 个字符的标题。',
  'errors.tooLarge': '正文超过大小上限，请缩减后重试。',
  'errors.invalidText': '粘贴的内容包含无效字符，请清理后重试。',
  'errors.versionConflict':
    '文档已被更新。你的草稿已保留，请读取最新版本后核对。',
  'errors.idempotencyConflict': '这次保存的请求已用于其他内容，请重新保存。',
  'errors.csrf': '会话已变化，请刷新会话后重试。',
  'documents.title': '我的文档',
  'reader.navigation': '文档内容',
  'reader.body': '正文',
  'documents.signInPrompt': '请先',
  'documents.signInAction': '登录',
  'documents.signInSuffix': '，再访问文档。',
  'documents.searchLabel': '标题关键词',
  'documents.searchPlaceholder': '搜索文档标题…',
  'documents.updatedColumn': '更新时间',
  'documents.versionColumn': '版本',
  'documents.searchHint':
    '最多 200 个字符，按标题字面查找。留空显示当前知识库文档。',
  'documents.search': '搜索',
  'documents.clearSearch': '清除搜索',
  'documents.loading': '正在查询文档…',
  'documents.retrySearch': '重新查询',
  'documents.emptyNoMatch': '没有匹配的文档',
  'documents.emptyNone': '暂无可访问的文档',
  'documents.emptyNoMatchHint': '换一个标题关键词，或清除搜索后重试。',
  'documents.emptyNoneHint': '从一篇 Markdown 开始，记录你的知识。',
  'documents.emptyHowTo': '点击“新建文档”，填写标题和正文后保存。',
  'documents.shownCount': '已显示 {count} 篇文档。',
  'documents.shownWithKeyword': '已显示 {count} 篇文档，关键词：{keyword}。',
  'documents.updated': '更新于 {date}',
  'documents.loadingMore': '正在加载…',
  'documents.retryLoadMore': '重试加载更多',
  'documents.loadMore': '加载更多',
  'documents.saveDenied': '保存权限已失效，草稿已保留。',
  'documents.readOnly': '你拥有只读权限，不能保存修改。',
  'documents.retryPermissions': '重新查询权限',
  'documents.titleLabel': '标题',
  'documents.markdownMode': 'Markdown 模式',
  'documents.tabEdit': '编辑',
  'documents.tabPreview': '预览',
  'documents.bodyLabel': 'Markdown 正文',
  'documents.bodyHint': '显式保存，正文最多 1 MiB。切换到预览查看排版。',
  'documents.conflictSection': '保存冲突',
  'documents.readingLatest': '正在读取最新版本…',
  'documents.readLatest': '读取最新版本',
  'documents.latestVersion': '最新版本 {version}：{title}',
  'documents.conflictHint': '核对上方最新内容，再选择如何继续。不会自动保存。',
  'documents.keepDraft': '已核对，保留草稿并继续',
  'documents.takeLatest': '放弃草稿，采用最新内容',
  'documents.baseline': '基于版本 {version} 编辑',
  'documents.save': '保存文档',
  'documents.unsavedChanges': '有未保存的更改',
  'documents.savedState': '所有更改已保存',
  'documents.notSaved': '尚未保存',
  'documents.backToBase': '返回知识库',
  'documents.readingBasePerms': '正在读取知识库权限…',
  'documents.readingDocument': '正在读取文档…',
  'documents.openBase': '所在知识库',
  'documents.edit': '编辑文档',
  'documents.backToDocument': '返回文档',

  // Knowledge bases: list, detail, rename.
  'errors.baseUnavailable':
    '知识库不存在、权限已变化或服务暂时不可用，请重新查询。',
  'bases.nameLabel': '知识库名称',
  'bases.nameInvalid': '请填写 1–120 个字符的有效名称。',
  'bases.nameHint': '管理员可修改名称与成员授权。',
  'bases.rename': '保存库名',
  'bases.title': '知识库',
  'bases.changeIcon': '更换{name}图标',
  'bases.backHome': '返回首页',
  'bases.signInToAccess': '登录后访问知识库',
  'bases.retry': '重新查询知识库',
  'bases.loading': '正在读取知识库…',
  'bases.create': '创建共享知识库',
  'bases.emptyTitle': '还没有可访问的知识库',
  'bases.emptyHint': '个人知识库会在首次保存文档时准备。',
  'bases.personalBadge': '个人库',
  'bases.sharedBadge': '共享库',
  'bases.accessReader': '只读',
  'bases.accessEditor': '可编辑',
  'bases.loadMore': '加载更多知识库',
  'bases.backToList': '知识库列表',
  'bases.readonlyStatus': '只读知识库',

  // Grants on a knowledge base.
  'grants.section': '知识库授权',
  'grants.hint':
    '文档和附件继承知识库权限。企业 Owner/Admin 始终拥有管理与读写权限。',
  'grants.loading': '正在读取授权与成员…',
  'grants.retryMembers': '重读成员',
  'grants.retryGrants': '重读授权',
  'grants.memberLabel': '选择成员',
  'grants.memberPlaceholder': '选择已启用成员',
  'grants.memberHint': '无需邀请，直接选择已经注册的成员。',
  'grants.accessLabel': '访问权限',
  'grants.save': '保存授权',
  'grants.loadMoreMembers': '加载更多成员',
  'grants.emptyTitle': '还没有额外授权',
  'grants.emptyHint': '选择已注册成员，授予只读或编辑权限。',
  'grants.revoke': '撤销 {email} 的授权',
  'grants.revokeAction': '撤销',
  'grants.loadMore': '加载更多授权',

  // Attachments on a document.
  'attachments.tooLarge': '文件超过上传上限，请选择较小的文件。',
  'attachments.uploadExpired': '上传已过期，请重新上传。',
  'attachments.uploadRejected': '文件校验失败，请重新选择文件或重新上传。',
  'attachments.invalidInput': '文件名、类型或校验信息无效，请重新选择。',
  'attachments.forbidden': '上传权限已失效，无法继续完成附件。',
  'attachments.errorTitle': '附件操作未完成',
  'attachments.fallback': '上传失败或下载暂时不可用，请重试。',
  'attachments.section': '文档附件',
  'attachments.heading': '附件',
  'attachments.retry': '重新查询附件',
  'attachments.loading': '正在读取附件…',
  'attachments.fileLabel': '选择附件',
  'attachments.hint': '上传后完成校验才会出现在附件列表。单文件上限 {size}。',
  'attachments.upload': '上传附件',
  'attachments.retryUpload': '重试上传',
  'attachments.progress': '附件上传进度',
  'attachments.preparing': '正在准备文件…',
  'attachments.verifying': '正在校验附件…',
  'attachments.uploading': '正在上传 {percent}%',
  'attachments.uploaded': '上传完成',
  'attachments.empty': '暂无附件',
  'attachments.download': '下载 {name}',
  'attachments.downloadAction': '下载',
  'attachments.insertRef': '插入引用',
  'attachments.loadMore': '加载更多附件',

  // Exports: panel, feedback, detail.
  'exports.section': '文档导出',
  'exports.heading': '导出文档',
  'exports.hint':
    '保存申请时的正文和附件为 ZIP。之后编辑文档不会改变这份导出。',
  'exports.requesting': '正在申请…',
  'exports.retryRequest': '重试申请导出',
  'exports.request': '导出当前文档',
  'exports.refresh': '刷新导出状态',
  'exports.loading': '正在读取导出记录…',
  'exports.empty': '暂无导出记录。',
  'exports.statusUpdating': '状态更新中',
  'exports.failedNote': '本次导出未完成，可重新申请。',
  'exports.expires': '有效期至 {date}',
  'exports.downloadZip': '下载 ZIP',
  'exports.loadMore': '加载更多导出',
  'exports.detailTitle': '导出详情',
  'exports.backToNotifications': '返回通知',
  'exports.signInFirst': '请先登录。',
  'exports.detailLoading': '正在读取导出结果…',
  'exports.reusableHint': '可回到文档重新申请导出。',
  'feedback.queued': '等待处理',
  'feedback.running': '正在生成',
  'feedback.retryWait': '等待重试',
  'feedback.succeeded': '导出完成',
  'feedback.failed': '导出失败',
  'feedback.expired': '已过期',
  'feedback.tooLarge': '文档和附件超过导出上限。',
  'feedback.expiredError': '导出已过期，请重新申请。',
  'feedback.notReady': '导出尚未完成，请刷新进度。',
  'feedback.forbidden': '当前无权操作这份文档。',
  'feedback.errorTitle': '导出操作未完成',
  'feedback.fallback': '暂时无法处理，请重试。',

  // Deletion of documents, bases and attachments.
  'delete.document': '删除文档',
  'delete.base': '删除知识库',
  'delete.attachment': '删除附件 {name}',
  'delete.resourceGone': '资源不存在，或你已失去访问权限。',
  'delete.forbidden': '当前没有删除权限。',
  'delete.confirmTitle': '删除“{name}”？',
  'delete.descAttachment': '正文中的附件引用将失效。',
  'delete.descDocument': '文档、附件和导出将无法访问。',
  'delete.descBase': '整个知识库的文档、附件和导出将无法访问。',
  'delete.descPersonal': '个人知识库删除后不会自动重建。',
  'delete.descIrreversible': '删除后无法恢复。',
  'delete.errorTitle': '删除未完成',
  'delete.fallback': '暂时无法删除，请重试或刷新查看最新状态。',
  'delete.confirm': '确认删除',
  'delete.deleting': '正在删除…',

  // Reader: markdown preview and attachment images.
  'reader.preparing': '正在准备预览…',
  'reader.attachmentImage': '附件图片：{alt}',
  'reader.unnamedImage': '未命名图片',
  'reader.imageFallback': '图片：{alt}',
  'reader.waitRetry': '请等待 {seconds} 秒',
  'reader.waitInline': '（请等待 {seconds} 秒）',
  'reader.retryImage': '重新读取图片',
  'reader.nameSuffix': '：{alt}',
  'reader.downloadingInline': '（正在下载）',
  'reader.downloadFailed': ' 下载失败，请重试。',

  // The unsaved-changes guard: keys live in this catalog, the router
  // adapter resolves them (it owns the blocker wiring, this example owns
  // the copy).
  'guard.unsavedTitle': '内容尚未保存',
  'guard.unsavedDescription':
    '离开会丢失当前草稿。正在保存的请求也可能继续完成。',
  'guard.continueEditing': '继续编辑',
  'guard.confirmLeave': '确认离开',

  // The design-system save-conflict scene (UI07): the editor's save
  // feedback demonstrated on demo data; failure and conflict reuse the
  // documents/errors keys above.
  'scene.saveConflict.title': '保存冲突与草稿保护',
  'scene.saveConflict.description':
    '编辑器的保存反馈在演示数据上运行：成功、失败、版本冲突与权限失效，不会写入真实文档。',
  'scene.saveConflict.stateSuccess': '保存成功',
  'scene.saveConflict.stateFailure': '保存失败',
  'scene.saveConflict.stateConflict': '版本冲突',
  'scene.saveConflict.stateDisabled': '权限失效',
  'scene.saveConflict.saved': '文档已保存（演示数据，仅局部状态）。',
  'scene.saveConflict.demoTitle': '演示文档',
  'scene.saveConflict.draftMarkdown':
    '# 演示文档\n\n我正在编辑这一段，尚未保存。',
  'scene.saveConflict.latestMarkdown': '# 演示文档\n\n另一位用户已更新这一段。',

  // The design-system attachment scene (UI08): the attachment list's file
  // icons (vendored Material Symbols subset) and upload lifecycle feedback
  // demonstrated on demo data.
  'scene.attachments.title': '附件图标与上传状态',
  'scene.attachments.description':
    '附件列表的文件图标与上传生命周期反馈在演示数据上运行，不会创建真实文件。',
  'scene.attachments.galleryTitle': '文件图标（Material Symbols 子集）',
  'scene.attachments.iconImage': '图片',
  'scene.attachments.iconDocument': '文档',
  'scene.attachments.stateUploading': '上传中',
  'scene.attachments.stateDone': '上传完成',
  'scene.attachments.stateFailed': '上传失败',
  'scene.attachments.demoImageName': '截图.png',
  'scene.attachments.demoImageMeta': '图片文件 · 24.0 KiB',
  'scene.attachments.demoDocName': '报告.pdf',
  'scene.attachments.demoDocMeta': '文件 · 1.2 MiB',

  // Structured notification display (UI09): resolved from the target type
  // and outcome at render time, never by matching the stored subject.
  'notifications.exportSucceeded': '文档导出完成',
  'notifications.exportFailed': '文档导出失败',

  // Export states and notification display demonstrated on demo data.
  'scene.exportStates.title': '导出状态与通知显示',
  'scene.exportStates.description':
    '导出状态徽标与通知标题按当前语言显示；未知类型保留原 subject 并显示功能不可用。',
  'scene.exportStates.statusTitle': '导出状态',
  'scene.exportStates.noticeTitle': '通知显示',
  'scene.exportStates.demoExportNotice': '已注册类型的通知（演示）',
  'scene.exportStates.demoUnknownNotice': '未知类型的通知（演示）',
};

const en: Catalog = {
  'common.newDocument': 'New document',
  'common.saving': 'Saving…',
  'common.downloading': 'Downloading…',
  'common.readingSession': 'Reading the session…',
  'common.version': 'Version {version}',
  'common.cancel': 'Cancel',
  'errors.unauthorized': 'Your session has expired. Sign in again.',
  'errors.docAccessLost': 'The document does not exist or access has lapsed.',
  'errors.actionIncomplete': 'The action did not complete',
  'errors.requestId': 'Request ID: {id}',
  'errors.fallback': 'The service is temporarily unavailable. Try again later.',

  'errors.writeForbidden':
    'You do not have write access. Contact an organization administrator.',
  'errors.docNotFound': 'The document does not exist, or you have lost access.',
  'errors.invalidSearch':
    'Search terms are limited to 200 characters and cannot contain invalid characters.',
  'errors.invalidPage': 'This page is no longer valid. Query again.',
  'errors.invalidTitle': 'Enter a title of at most 200 characters.',
  'errors.tooLarge': 'The body exceeds the size limit. Shorten it and retry.',
  'errors.invalidText':
    'The pasted content contains invalid characters. Clean it up and retry.',
  'errors.versionConflict':
    'The document was updated. Your draft is preserved — read the latest version and reconcile.',
  'errors.idempotencyConflict':
    'This save request was already used for other content. Save again.',
  'errors.csrf': 'The session changed. Refresh it and retry.',
  'documents.title': 'My documents',
  'reader.navigation': 'Document content',
  'reader.body': 'Document',
  'documents.signInPrompt': 'Please ',
  'documents.signInAction': 'sign in',
  'documents.signInSuffix': ' to access documents.',
  'documents.searchLabel': 'Title keywords',
  'documents.searchPlaceholder': 'Search document titles…',
  'documents.updatedColumn': 'Updated',
  'documents.versionColumn': 'Version',
  'documents.searchHint':
    'Up to 200 characters, matched literally in the title. Leave empty to list the current knowledge base.',
  'documents.search': 'Search',
  'documents.clearSearch': 'Clear search',
  'documents.loading': 'Loading documents…',
  'documents.retrySearch': 'Query again',
  'documents.emptyNoMatch': 'No matching documents',
  'documents.emptyNone': 'No documents available yet',
  'documents.emptyNoMatchHint':
    'Try other title keywords, or clear the search and retry.',
  'documents.emptyNoneHint':
    'Start with a Markdown document and record what you know.',
  'documents.emptyHowTo':
    'Click “New document”, fill in a title and body, then save.',
  'documents.shownCount': 'Documents shown: {count}.',
  'documents.shownWithKeyword': 'Documents shown for “{keyword}”: {count}.',
  'documents.updated': 'Updated {date}',
  'documents.loadingMore': 'Loading…',
  'documents.retryLoadMore': 'Retry loading more',
  'documents.loadMore': 'Load more',
  'documents.saveDenied': 'Save access has lapsed. Your draft is preserved.',
  'documents.readOnly': 'You have read-only access and cannot save changes.',
  'documents.retryPermissions': 'Re-check access',
  'documents.titleLabel': 'Title',
  'documents.markdownMode': 'Markdown mode',
  'documents.tabEdit': 'Edit',
  'documents.tabPreview': 'Preview',
  'documents.bodyLabel': 'Markdown body',
  'documents.bodyHint':
    'Saved explicitly; the body is limited to 1 MiB. Switch to Preview to see the layout.',
  'documents.conflictSection': 'Save conflict',
  'documents.readingLatest': 'Reading the latest version…',
  'documents.readLatest': 'Read latest version',
  'documents.latestVersion': 'Latest version {version}: {title}',
  'documents.conflictHint':
    'Review the latest content above, then choose how to continue. Nothing saves automatically.',
  'documents.keepDraft': 'Reviewed; keep my draft and continue',
  'documents.takeLatest': 'Discard my draft and take the latest',
  'documents.baseline': 'Editing from version {version}',
  'documents.save': 'Save document',
  'documents.unsavedChanges': 'Unsaved changes',
  'documents.savedState': 'All changes saved',
  'documents.notSaved': 'Not saved yet',
  'documents.backToBase': 'Back to the knowledge base',
  'documents.readingBasePerms': 'Reading knowledge base access…',
  'documents.readingDocument': 'Reading the document…',
  'documents.openBase': 'Open the knowledge base',
  'documents.edit': 'Edit document',
  'documents.backToDocument': 'Back to the document',

  'errors.baseUnavailable':
    'The knowledge base does not exist, access has changed, or the service is temporarily unavailable. Query again.',
  'bases.nameLabel': 'Knowledge base name',
  'bases.nameInvalid': 'Enter a valid name of 1–120 characters.',
  'bases.nameHint':
    'Administrators can rename the knowledge base and manage member grants.',
  'bases.rename': 'Save name',
  'bases.title': 'Knowledge bases',
  'bases.changeIcon': 'Change {name} icon',
  'bases.backHome': 'Back home',
  'bases.signInToAccess': 'Sign in to access knowledge bases',
  'bases.retry': 'Query knowledge bases again',
  'bases.loading': 'Reading knowledge bases…',
  'bases.create': 'Create shared knowledge base',
  'bases.emptyTitle': 'No knowledge bases available yet',
  'bases.emptyHint':
    'Your personal knowledge base is prepared the first time you save a document.',
  'bases.personalBadge': 'Personal',
  'bases.sharedBadge': 'Shared',
  'bases.accessReader': 'Read-only',
  'bases.accessEditor': 'Editable',
  'bases.loadMore': 'Load more knowledge bases',
  'bases.backToList': 'Knowledge base list',
  'bases.readonlyStatus': 'Read-only knowledge base',

  'grants.section': 'Knowledge base access',
  'grants.hint':
    'Documents and attachments inherit the knowledge base’s access. Organization Owner/Admin always hold management and read-write access.',
  'grants.loading': 'Reading grants and members…',
  'grants.retryMembers': 'Re-read members',
  'grants.retryGrants': 'Re-read grants',
  'grants.memberLabel': 'Select member',
  'grants.memberPlaceholder': 'Select an active member',
  'grants.memberHint':
    'No invitations needed: pick among registered members directly.',
  'grants.accessLabel': 'Access',
  'grants.save': 'Save grant',
  'grants.loadMoreMembers': 'Load more members',
  'grants.emptyTitle': 'No extra grants yet',
  'grants.emptyHint':
    'Select a registered member to grant read-only or editing access.',
  'grants.revoke': 'Revoke {email}’s access',
  'grants.revokeAction': 'Revoke',
  'grants.loadMore': 'Load more grants',

  'attachments.tooLarge':
    'The file exceeds the upload limit. Choose a smaller one.',
  'attachments.uploadExpired': 'The upload expired. Upload again.',
  'attachments.uploadRejected':
    'File verification failed. Choose the file again or re-upload.',
  'attachments.invalidInput':
    'The file name, type or verification data is invalid. Choose again.',
  'attachments.forbidden':
    'Upload access has lapsed; attachments cannot be completed.',
  'attachments.errorTitle': 'The attachment action did not complete',
  'attachments.fallback':
    'The upload failed or downloads are unavailable. Retry.',
  'attachments.section': 'Document attachments',
  'attachments.heading': 'Attachments',
  'attachments.retry': 'Query attachments again',
  'attachments.loading': 'Reading attachments…',
  'attachments.fileLabel': 'Choose attachment',
  'attachments.hint':
    'Attachments appear in the list after verification completes. One-file limit: {size}.',
  'attachments.upload': 'Upload attachment',
  'attachments.retryUpload': 'Retry upload',
  'attachments.progress': 'Attachment upload progress',
  'attachments.preparing': 'Preparing the file…',
  'attachments.verifying': 'Verifying the attachment…',
  'attachments.uploading': 'Uploading {percent}%',
  'attachments.uploaded': 'Upload complete',
  'attachments.empty': 'No attachments yet',
  'attachments.download': 'Download {name}',
  'attachments.downloadAction': 'Download',
  'attachments.insertRef': 'Insert reference',
  'attachments.loadMore': 'Load more attachments',

  'exports.section': 'Document exports',
  'exports.heading': 'Export the document',
  'exports.hint':
    'Saves the body and attachments at request time as a ZIP. Later edits never change this export.',
  'exports.requesting': 'Requesting…',
  'exports.retryRequest': 'Retry the export request',
  'exports.request': 'Export this document',
  'exports.refresh': 'Refresh export status',
  'exports.loading': 'Reading export records…',
  'exports.empty': 'No export records yet.',
  'exports.statusUpdating': 'Status updating',
  'exports.failedNote':
    'This export did not complete; you can request it again.',
  'exports.expires': 'Valid until {date}',
  'exports.downloadZip': 'Download ZIP',
  'exports.loadMore': 'Load more exports',
  'exports.detailTitle': 'Export details',
  'exports.backToNotifications': 'Back to notifications',
  'exports.signInFirst': 'Please sign in first.',
  'exports.detailLoading': 'Reading the export result…',
  'exports.reusableHint':
    'You can return to the document and request the export again.',
  'feedback.queued': 'Queued',
  'feedback.running': 'Generating',
  'feedback.retryWait': 'Waiting to retry',
  'feedback.succeeded': 'Export complete',
  'feedback.failed': 'Export failed',
  'feedback.expired': 'Expired',
  'feedback.tooLarge': 'The document and attachments exceed the export limit.',
  'feedback.expiredError': 'The export expired. Request it again.',
  'feedback.notReady': 'The export is not ready yet. Refresh its progress.',
  'feedback.forbidden': 'You currently lack access to this document.',
  'feedback.errorTitle': 'The export action did not complete',
  'feedback.fallback': 'It cannot be processed right now. Retry.',

  'delete.document': 'Delete document',
  'delete.base': 'Delete knowledge base',
  'delete.attachment': 'Delete attachment {name}',
  'delete.resourceGone':
    'The resource does not exist, or you have lost access.',
  'delete.forbidden': 'You currently lack delete access.',
  'delete.confirmTitle': 'Delete “{name}”?',
  'delete.descAttachment': 'Attachment references in the body will break.',
  'delete.descDocument':
    'The document, its attachments and exports will become inaccessible.',
  'delete.descBase':
    'Every document, attachment and export in the knowledge base will become inaccessible.',
  'delete.descPersonal':
    'A deleted personal knowledge base is not recreated automatically.',
  'delete.descIrreversible': 'Deletion cannot be undone.',
  'delete.errorTitle': 'The deletion did not complete',
  'delete.fallback':
    'It cannot be deleted right now. Retry or refresh to see the latest state.',
  'delete.confirm': 'Confirm deletion',
  'delete.deleting': 'Deleting…',

  'reader.preparing': 'Preparing the preview…',
  'reader.attachmentImage': 'Attachment image: {alt}',
  'reader.unnamedImage': 'Unnamed image',
  'reader.imageFallback': 'Image: {alt}',
  'reader.waitRetry': 'Please wait {seconds} s',
  'reader.waitInline': ' (wait {seconds} s)',
  'reader.retryImage': 'Reload the image',
  'reader.nameSuffix': ': {alt}',
  'reader.downloadingInline': ' (downloading)',
  'reader.downloadFailed': ' Download failed; retry.',

  'guard.unsavedTitle': 'Unsaved changes',
  'guard.unsavedDescription':
    'Leaving loses the current draft. An in-flight save may still complete.',
  'guard.continueEditing': 'Keep editing',
  'guard.confirmLeave': 'Leave anyway',

  // The design-system save-conflict scene (UI07): the editor's save
  // feedback demonstrated on demo data; failure and conflict reuse the
  // documents/errors keys above.
  'scene.saveConflict.title': 'Save conflicts and draft protection',
  'scene.saveConflict.description':
    'Save feedback from the editor runs on demo data: success, failure, version conflict and lost permission — nothing is written.',
  'scene.saveConflict.stateSuccess': 'Save succeeds',
  'scene.saveConflict.stateFailure': 'Save fails',
  'scene.saveConflict.stateConflict': 'Version conflict',
  'scene.saveConflict.stateDisabled': 'Permission lost',
  'scene.saveConflict.saved': 'Document saved (demo data, local state only).',
  'scene.saveConflict.demoTitle': 'Demo document',
  'scene.saveConflict.draftMarkdown':
    '# Demo document\n\nI am editing this paragraph; it is not saved yet.',
  'scene.saveConflict.latestMarkdown':
    '# Demo document\n\nAnother user has updated this paragraph.',

  'scene.attachments.title': 'Attachment icons and upload states',
  'scene.attachments.description':
    "The attachment list's file icons and upload lifecycle feedback run on demo data — no real files are created.",
  'scene.attachments.galleryTitle': 'File icons (Material Symbols subset)',
  'scene.attachments.iconImage': 'Image',
  'scene.attachments.iconDocument': 'Document',
  'scene.attachments.stateUploading': 'Uploading',
  'scene.attachments.stateDone': 'Uploaded',
  'scene.attachments.stateFailed': 'Upload failed',
  'scene.attachments.demoImageName': 'screenshot.png',
  'scene.attachments.demoImageMeta': 'Image file · 24.0 KiB',
  'scene.attachments.demoDocName': 'report.pdf',
  'scene.attachments.demoDocMeta': 'File · 1.2 MiB',

  // Structured notification display (UI09): resolved from the target type
  // and outcome at render time, never by matching the stored subject.
  'notifications.exportSucceeded': 'Document export completed',
  'notifications.exportFailed': 'Document export failed',

  // Export states and notification display demonstrated on demo data.
  'scene.exportStates.title': 'Export states and notification display',
  'scene.exportStates.description':
    'Export status badges and notification headings follow the active language; unknown types keep the original subject and show unavailable feedback.',
  'scene.exportStates.statusTitle': 'Export status',
  'scene.exportStates.noticeTitle': 'Notification display',
  'scene.exportStates.demoExportNotice': 'A notice of a registered type (demo)',
  'scene.exportStates.demoUnknownNotice': 'A notice of an unknown type (demo)',
};

export const knowledgeMessages: {
  zh: Record<string, string>;
  en: Record<string, string>;
} = { zh, en };
