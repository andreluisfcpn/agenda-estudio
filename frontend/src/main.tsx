import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './styles/index.css';
import './styles/sidebar.css';
import './styles/topbar.css';
import './styles/bottom-tab-bar.css';
import './styles/landing.css';
import './styles/login-modal.css';
import './styles/checkout.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
        <App />
    </React.StrictMode>
);
