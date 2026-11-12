import { createApp } from 'vue';
import { createPinia } from 'pinia';
import PrimeVue from 'primevue/config';
import Aura from '@primevue/themes/aura';
import 'primeicons/primeicons.css';
import ToastService from 'primevue/toastservice';
import ConfirmationService from 'primevue/confirmationservice';
import router from './router';
import './styles/themes.css';
import './style.css';
import './styles/bracket-theme.css';
import App from './App.vue';

const brandId = import.meta.env.VITE_BRAND ?? 'gt';
document.documentElement.setAttribute('data-theme', brandId);

const app = createApp(App);

app.use(createPinia());
app.use(router);
app.use(ToastService);
app.use(ConfirmationService);
app.use(PrimeVue, {
  ripple: true,
  theme: {
    preset: Aura,
    options: {
      cssLayer: true,
      // ECVA is a light app: never switch PrimeVue components to dark, even when the OS is in
      // dark mode. GT keeps following the system setting as before.
      darkModeSelector: brandId === 'ecva' ? '.prime-dark-disabled' : 'system',
    },
  },
});

app.mount('#app');
