// Chinese steps reproduce ChenXing's manuscript; figure markers become images.
// Editorial changes require her approval. English is a faithful translation.
const step = (zh, en, ...figures) => ({ zh, en, figures });
export const platformImportGuides = Object.freeze([
  { id: 'deepseek', name: 'DeepSeek', website: 'https://chat.deepseek.com/', methods: [{ steps: [
    step('点击设置→数据管理→导出所有历史会话', 'Click Settings → Data Management → Export all chat history', 1),
    step('点击下载按钮。', 'Click Download.', 2),
    step('解压ZIP文件', 'Extract the ZIP file', 3),
    step('在采云导入解压后的conversations.json，或将此文件复制入Cloudig\\Inbox\\', 'Import the extracted conversations.json into Cloudig, or copy it into Cloudig\\Inbox\\', 4)
  ] }] },
  { id: 'qwen', name: 'Qwen', website: 'https://chat.qwen.ai/', methods: [{ steps: [
    step('点击设置→聊天→导出对话', 'Click Settings → Chats → Export chats', 1),
    step('在采云导入下载的chat-export-*.json，或将此文件复制入Cloudig\\Inbox\\', 'Import the downloaded chat-export-*.json into Cloudig, or copy it into Cloudig\\Inbox\\', 2)
  ] }] },
  { id: 'mistral', name: 'Mistral', website: 'https://chat.mistral.ai/', methods: [{ steps: [
    step('点击左下角profile→Vibe→Export', 'Click Profile at the bottom left → Vibe → Export', 1),
    step('点击Download', 'Click Download', 2),
    step('在采云导入下载的chat-export-*.zip，或将此文件复制入Cloudig\\Inbox\\', 'Import the downloaded chat-export-*.zip into Cloudig, or copy it into Cloudig\\Inbox\\', 3)
  ] }] },
  { id: 'grok', name: 'Grok', website: 'https://grok.com/', methods: [{ steps: [
    step('点击左下角头像→设置→数据管理→导出账户数据', 'Click your avatar at the bottom left → Settings → Data Controls → Export account data', 1),
    step('点击下载账户数据后会收到邮件通知', 'Click Download account data. You will receive an email notification', 2, 3),
    step('登录邮箱检查邮件，点击Download data', 'Check your email and click Download data', 4),
    step('在采云导入下载的*.zip，或将此文件复制入Cloudig\\Inbox\\', 'Import the downloaded *.zip into Cloudig, or copy it into Cloudig\\Inbox\\', 5)
  ] }] },
  { id: 'claude', name: 'Claude', website: 'https://claude.ai/', methods: [{ title: ['方法1', 'Method 1'], steps: [
    step('点击左下角头像→Settings→Privacy→Export data', 'Click your avatar at the bottom left → Settings → Privacy → Export data', 1),
    step('选择你想要导出的范围→Export', 'Select the range you want to export → Export', 2),
    step('登录邮箱，会收到等待通知邮件', 'Check your email. You will receive a notification that your export is in progress', 3),
    step('收到正式下载邮件后，点击Download data', 'When the download email arrives, click Download data', 4),
    step('打开下载的manifest-*.json文件', 'Open the downloaded manifest-*.json file', 5),
    step('找到 "category": "conversations","filename": "conversations-000.zip"一段，复制export_url后的地址，输入浏览器，下载文件。', 'Find the section containing "category": "conversations","filename": "conversations-000.zip". Copy the address after export_url, paste it into your browser, and download the file.', 6),
    step('解压conversations-000.zip', 'Extract conversations-000.zip', 7),
    step('在采云导入解压后的conversations.json，或将此文件复制入Cloudig\\Inbox\\', 'Import the extracted conversations.json into Cloudig, or copy it into Cloudig\\Inbox\\', 8)
  ] }, { title: ['方法2', 'Method 2'], steps: [
    step('封号后，点击Export your data，把下载的文件解压后，得到conversations.json，将其导入采云，或将此文件复制入Cloudig\\Inbox\\', 'After your account is suspended, click Export your data. Extract the downloaded file to obtain conversations.json, then import it into Cloudig or copy it into Cloudig\\Inbox\\', 9)
  ] }] },
  { id: 'chatgpt', name: 'ChatGPT', imagePrefix: 'GPT', website: 'https://chatgpt.com/', methods: [
    { title: ['方法1:', 'Method 1:'], steps: [
      step('点击左下角头像→设置→数据管理→导出数据', 'Click your avatar at the bottom left → Settings → Data Controls → Export data', 1),
      step('确认导出，可能需要重新验证登录与邮箱。', 'Confirm the export. You may need to verify your login and email again.', 2),
      step('邮箱中收到“数据导出已启动”邮件，然后耐心等待。', 'When you receive the “Data export has started” email, wait patiently.', 3),
      step('收到“数据导出已准备就绪”邮件，点击下载数据导出。', 'When you receive the “Your data export is ready” email, click Download data export.', 8),
      step('将下载的*.zip直接导入采云，或将此文件复制入Cloudig\\Inbox\\', 'Import the downloaded *.zip directly into Cloudig, or copy it into Cloudig\\Inbox\\')
    ] },
    { title: ['方法2:', 'Method 2:'], steps: [
      step('登录privacy.openai.com网站，提交隐私请求，选择下载我的数据。', 'Sign in to privacy.openai.com, submit a privacy request, and choose to download your data.', 4),
      step('按照发送的邮件指示操作后，会得到文件OpenAI-export.zip', 'Follow the instructions in the email to obtain OpenAI-export.zip', 5),
      step('解压文件', 'Extract the file', 6),
      step('打开User Online Activity文件夹，导入conversations*.zip，或将此文件复制入Cloudig\\Inbox\\', 'Open the User Online Activity folder and import conversations*.zip, or copy it into Cloudig\\Inbox\\', 7)
    ] }
  ] }
]);
export const guideImagePath = (guide, figure) => `/pages/archiver/assets/import-guide/${guide.name}-${String(figure).padStart(2, '0')}.png`;
