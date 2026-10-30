import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default {
  entry: "./src/index.ts",
  mode: "production",
  optimization: { minimize: false },
  target: "webworker",
  output: {
    filename: "index.js",
    path: path.resolve(__dirname, "build"),
    library: { type: "module" },
  },
  experiments: { outputModule: true },
  module: {
    rules: [
      {
        test: /\.ts$/,
        use: "ts-loader",
        exclude: /node_modules/,
      },
      {
        test: /\.(hbs|css)$/,
        type: "asset/source",
      },
      {
        test: /\.woff2$/,
        type: "asset/inline",
      },
      {
        test: /shared\/js\/.*\.js$/,
        type: "asset/source",
      },
    ],
  },
  resolve: {
    extensions: [".ts", ".js"],
    extensionAlias: {
      ".js": [".ts", ".js"],
    },
  },
  externals: [
    /^fastly:.*/,
  ],
};
