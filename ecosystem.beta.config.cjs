module.exports = {
  apps: [
    {
      name: "sistema-pecas-beta",
      script: "dist/server/server/index.js",
      cwd: "C:\\Users\\Rocha Telecom\\Documents\\SISTEMAS DE PEÇAS",
      env: {
        DATABASE_PATH: "C:\\Users\\Rocha Telecom\\Documents\\SISTEMAS DE PEÇAS\\data\\app-beta.sqlite",
        SERVER_PORT: "3001",
        NODE_ENV: "production",
      },
    },
  ],
};
