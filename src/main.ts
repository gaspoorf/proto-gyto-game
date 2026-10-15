import '@fontsource-variable/inter';
import './style.css';
import { Game } from './game/Game';

const canvas = document.getElementById('gl') as HTMLCanvasElement;
const game = new Game(canvas);
// Exposed for debugging and automated checks.
(window as unknown as { __game: Game }).__game = game;

game.init().catch((e) => {
  console.error(e);
  game.ui.fatal(`Erreur au démarrage : ${(e as Error).message || e}`);
});
