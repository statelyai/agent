# Getting started

This directory in the `@stately/agent` repository has a self-contained app for a Joke Generator. It consists of a React/Vite client as well as a nested `server` directory for the express server app.

Install dependencies for client and server using [`pnpm`](https://pnpm.io/):

`pnpm run install` or `pnpm run i`

Sure, here's a simple markdown table as requested:

| Name            | Script            | Description                             |
| --------------- | ----------------- | --------------------------------------- |
| Client only     | `pnpm run client` | Runs the client React app only          |
| Server only     | `pnpm run server` | Runs the express server only            |
| Client + Server | `pnpm run dev`    | Runs the client and server concurrently |

After running `pnpm run dev`, go to `http://localhost:3000` to view the app for the Joke Generator.

# React + TypeScript + Vite

This template provides a minimal setup to get React working in Vite with HMR and some ESLint rules.

Currently, two official plugins are available:

- [@vitejs/plugin-react](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react/README.md) uses [Babel](https://babeljs.io/) for Fast Refresh
- [@vitejs/plugin-react-swc](https://github.com/vitejs/vite-plugin-react-swc) uses [SWC](https://swc.rs/) for Fast Refresh

## Expanding the ESLint configuration

If you are developing a production application, we recommend updating the configuration to enable type aware lint rules:

- Configure the top-level `parserOptions` property like this:

```js
export default {
  // other rules...
  parserOptions: {
    ecmaVersion: 'latest',
    sourceType: 'module',
    project: ['./tsconfig.json', './tsconfig.node.json'],
    tsconfigRootDir: __dirname,
  },
};
```

- Replace `plugin:@typescript-eslint/recommended` to `plugin:@typescript-eslint/recommended-type-checked` or `plugin:@typescript-eslint/strict-type-checked`
- Optionally add `plugin:@typescript-eslint/stylistic-type-checked`
- Install [eslint-plugin-react](https://github.com/jsx-eslint/eslint-plugin-react) and add `plugin:react/recommended` & `plugin:react/jsx-runtime` to the `extends` list
