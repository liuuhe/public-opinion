import { Container } from "@cloudflare/containers";

export class BertContainer extends Container {
  defaultPort = 7860;
  sleepAfter = "5m";
  envVars = {
    MODEL_DIR: "model"
  };

  override onStart() {
    console.log("BERT container started");
  }

  override onStop() {
    console.log("BERT container stopped");
  }

  override onError(error: unknown) {
    console.log("BERT container error", error);
  }
}
