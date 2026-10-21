import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './app/App.vue'
import './assets/main.css'
import './assets/workspace.css'
createApp(App).use(createPinia()).mount('#app')
