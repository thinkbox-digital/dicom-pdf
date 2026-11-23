package digital.thinkbox.dicompdf;

import java.io.IOException;
import java.nio.file.Path;
import javafx.animation.AnimationTimer;
import javafx.application.Application;
import javafx.application.Platform;
import javafx.embed.swing.SwingFXUtils;
import javafx.scene.control.Button;
import javafx.scene.control.Label;
import javafx.stage.Stage;
import javafx.stage.Window;
import javax.imageio.ImageIO;

/** Captures the viewer with a synthetic archive for the repository README. */
public final class DesktopViewerScreenshot {
    private static Exception failure;

    public static void main(String[] args) throws Exception {
        Application.launch(Capture.class, args);
        if (failure != null) throw failure;
    }

    public static final class Capture extends Application {
        private final DesktopViewer viewer = new DesktopViewer();

        @Override public void start(Stage stage) {
            var args = getParameters().getRaw();
            var output = Path.of(args.get(1));
            viewer.start(stage, Path.of(args.getFirst()));
            var scene = stage.getScene();
            long started = System.nanoTime();
            new AnimationTimer() {
                private boolean captured;
                private double width;
                private double height;

                @Override public void handle(long now) {
                    try {
                        if (System.nanoTime() - started >= 30_000_000_000L)
                            throw new IOException("Timed out opening the synthetic CT image or its metadata.");
                        if (!captured) {
                            boolean loaded = scene.getRoot().lookupAll(".footer .label").stream()
                                    .anyMatch(node -> node instanceof Label label && label.getText().contains("Original SHA-256 verified"));
                            if (!loaded) return;
                            var image = SwingFXUtils.fromFXImage(scene.snapshot(null), null);
                            if (!ImageIO.write(image, "png", output.toFile())) throw new IOException("No PNG writer available.");
                            width = stage.getWidth();
                            height = stage.getHeight();
                            captured = true;
                            ((Button) scene.lookup(".metadata-open")).fire();
                            return;
                        }
                        var close = (Button) scene.lookup(".selected-metadata-close");
                        if (close == null) return;
                        if (stage.getWidth() != width || stage.getHeight() != height
                                || Window.getWindows().stream().filter(Window::isShowing).count() != 1)
                            throw new IOException("Selected file metadata must open inside the existing viewer window.");
                        close.fire();
                        if (scene.lookup(".selected-metadata-dialog") != null)
                            throw new IOException("The metadata overlay did not close.");
                        stop();
                        Platform.exit();
                    } catch (Exception error) {
                        failure = error;
                        stop();
                        Platform.exit();
                    }
                }
            }.start();
        }

        @Override public void stop() {
            viewer.stop();
        }
    }
}
