import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
// 保留原静态视图的样式顺序与跨页级联，只延迟 JavaScript 视图模块。
import './chat/chat-presentation.css';
import './characters/workshop/character-workshop.css';
import './styles.css';

const root = document.getElementById('root');
if (!root) throw new Error('缺少 Renderer 根节点');

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>
);
