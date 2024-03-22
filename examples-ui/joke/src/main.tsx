import React from 'react';
import ReactDOM from 'react-dom/client';
import { Joke } from './Joke.tsx';
import './index.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Joke />
  </React.StrictMode>,
);
