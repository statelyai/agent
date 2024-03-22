import React from 'react';
import ReactDOM from 'react-dom/client';
import { TicTacToe } from './TicTacToe.tsx';
import './index.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <TicTacToe />
  </React.StrictMode>,
);
