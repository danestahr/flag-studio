import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import CustomerPagePlain from './CustomerPagePlain.jsx';

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <CustomerPagePlain />
  </StrictMode>
);
