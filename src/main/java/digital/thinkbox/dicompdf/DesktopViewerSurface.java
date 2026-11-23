package digital.thinkbox.dicompdf;

import java.util.List;
import javafx.application.ConditionalFeature;
import javafx.scene.*;
import javafx.scene.control.Label;
import javafx.scene.input.MouseButton;
import javafx.scene.layout.StackPane;
import javafx.scene.paint.Color;
import javafx.scene.paint.PhongMaterial;
import javafx.scene.shape.CullFace;
import javafx.scene.shape.MeshView;
import javafx.scene.shape.TriangleMesh;
import javafx.scene.transform.Rotate;

final class DesktopViewerSurface extends StackPane {
    private final Rotate pitch = new Rotate(-18, Rotate.X_AXIS), yaw = new Rotate(25, Rotate.Y_AXIS);
    private final Group model = new Group(), translation = new Group(model);
    private final PerspectiveCamera camera = new PerspectiveCamera(true);
    private double x;
    private double y;

    DesktopViewerSurface(List<DesktopViewerSpecial.Surface> surfaces) {
        getStyleClass().add("image-viewport");
        setMinSize(0, 0);
        setPickOnBounds(true);
        if (!javafx.application.Platform.isSupported(ConditionalFeature.SCENE3D)) {
            getChildren().add(new Label("3D surface display requires JavaFX 3D support."));
            return;
        }
        Color[] colors = {Color.LIGHTSKYBLUE, Color.LIGHTGREEN, Color.LIGHTSALMON, Color.PLUM};
        for (var surface : surfaces) {
            var mesh = new TriangleMesh();
            mesh.getPoints().setAll(surface.coordinates());
            mesh.getTexCoords().setAll(0, 0);
            int[] faces = new int[surface.triangles().length * 2];
            for (int i = 0; i < surface.triangles().length; i++) faces[i * 2] = surface.triangles()[i];
            mesh.getFaces().setAll(faces);
            var view = new MeshView(mesh);
            view.setCullFace(CullFace.NONE);
            view.setMaterial(new PhongMaterial(colors[model.getChildren().size() % colors.length]));
            model.getChildren().add(view);
        }
        var bounds = model.getBoundsInLocal();
        double extent = Math.max(bounds.getWidth(), Math.max(bounds.getHeight(), bounds.getDepth()));
        double scale = 180 / Math.max(extent, 1e-8);
        model.getTransforms().setAll(pitch, yaw, new javafx.scene.transform.Scale(scale, scale, scale),
                new javafx.scene.transform.Translate(-bounds.getCenterX(), -bounds.getCenterY(), -bounds.getCenterZ()));
        var light = new PointLight(Color.WHITE);
        light.setTranslateX(-250);
        light.setTranslateY(-220);
        light.setTranslateZ(-400);
        var scene = new SubScene(new Group(translation, new AmbientLight(Color.color(.55, .55, .55)), light),
                1, 1, true, SceneAntialiasing.BALANCED);
        scene.setFill(Color.web("#101722"));
        scene.setCamera(camera);
        camera.setNearClip(0.1);
        camera.setFarClip(5000);
        reset();
        scene.widthProperty().bind(widthProperty());
        scene.heightProperty().bind(heightProperty());
        getChildren().add(scene);
        scene.setOnMousePressed(event -> { x = event.getX(); y = event.getY(); });
        scene.setOnMouseDragged(event -> {
            double dx = event.getX() - x, dy = event.getY() - y;
            if (event.isShiftDown() || event.isSecondaryButtonDown()) {
                translation.setTranslateX(translation.getTranslateX() + dx);
                translation.setTranslateY(translation.getTranslateY() + dy);
            } else {
                yaw.setAngle(yaw.getAngle() + dx / 2);
                pitch.setAngle(pitch.getAngle() - dy / 2);
            }
            x = event.getX();
            y = event.getY();
        });
        setOnScroll(event -> {
            double delta = event.getDeltaY();
            if (delta == 0) return;
            double factor = delta > 0 ? 1 / 1.1 : 1.1;
            camera.setTranslateZ(Math.clamp(camera.getTranslateZ() * factor, -2200, -180));
            event.consume();
        });
        scene.setOnMouseClicked(event -> {
            if (event.getButton() == MouseButton.PRIMARY && event.getClickCount() == 2) reset();
        });
    }

    private void reset() {
        pitch.setAngle(-18);
        yaw.setAngle(25);
        translation.setTranslateX(0);
        translation.setTranslateY(0);
        camera.setTranslateZ(-680);
    }
}
