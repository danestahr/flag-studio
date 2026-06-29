import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import CustomerPage from './CustomerPage.jsx';

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <CustomerPage />
  </StrictMode>
);
