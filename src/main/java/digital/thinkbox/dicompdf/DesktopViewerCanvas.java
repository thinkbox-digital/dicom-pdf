package digital.thinkbox.dicompdf;

import javafx.beans.binding.Bindings;
import javafx.geometry.Insets;
import javafx.geometry.Pos;
import javafx.scene.Cursor;
import javafx.scene.control.Label;
import javafx.scene.effect.ColorAdjust;
import javafx.scene.effect.ColorInput;
import javafx.scene.effect.Blend;
import javafx.scene.effect.BlendMode;
import javafx.scene.image.Image;
import javafx.scene.image.ImageView;
import javafx.scene.layout.StackPane;
import javafx.scene.layout.VBox;
import javafx.scene.paint.Color;
import javafx.scene.shape.Rectangle;

final class DesktopViewerCanvas extends StackPane {
    private final ImageView image = new ImageView();
    private final ColorAdjust adjustment = new ColorAdjust();
    private final StackPane overlays = new StackPane();
    private final Label topLeft = overlayLabel(Pos.TOP_LEFT);
    private final Label bottomLeft = overlayLabel(Pos.BOTTOM_LEFT);
    private final Label bottomRight = overlayLabel(Pos.BOTTOM_RIGHT);
    private final Label[] directions = {overlayLabel(Pos.TOP_CENTER), overlayLabel(Pos.CENTER_RIGHT),
            overlayLabel(Pos.BOTTOM_CENTER), overlayLabel(Pos.CENTER_LEFT)};
    private DesktopViewerOverlay.Context overlayContext;
    private final Label prompt = new Label("Open a DICOM PDF");
    private final Label instructions = new Label("Drop a converted DICOM PDF here or use Open PDF.");
    private final VBox empty;
    private double zoom = 1;
    private double rowRatio = 1;
    private double dragX;
    private double dragY;
    private boolean inverted;

    DesktopViewerCanvas(Image icon) {
        setMinSize(0, 0);
        getStyleClass().add("image-viewport");
        image.setSmooth(true);
        image.setEffect(adjustment);
        image.setMouseTransparent(true);
        var mark = new ImageView(icon);
        mark.setFitWidth(64);
        mark.setFitHeight(64);
        prompt.getStyleClass().add("empty-title");
        empty = new VBox(10, mark, prompt, instructions, new Label("Files stay on this device."));
        empty.setAlignment(Pos.CENTER);
        empty.setMouseTransparent(true);
        overlays.getChildren().addAll(topLeft, bottomLeft, bottomRight);
        overlays.getChildren().addAll(directions);
        overlays.setMouseTransparent(true);
        topLeft.setWrapText(true);
        topLeft.maxWidthProperty().bind(widthProperty().multiply(.44));
        getChildren().addAll(image, empty, overlays);
        var clip = new Rectangle();
        clip.widthProperty().bind(widthProperty());
        clip.heightProperty().bind(heightProperty());
        setClip(clip);
        widthProperty().addListener(ignored -> fit());
        heightProperty().addListener(ignored -> fit());
        image.imageProperty().addListener(ignored -> fit());
        empty.visibleProperty().bind(image.imageProperty().isNull());
        cursorProperty().bind(Bindings.when(image.imageProperty().isNull())
                .then(Cursor.DEFAULT).otherwise(Cursor.OPEN_HAND));
        setOnMousePressed(event -> {
            dragX = event.getX();
            dragY = event.getY();
        });
        setOnMouseDragged(event -> {
            if (!event.isPrimaryButtonDown() || image.getImage() == null) return;
            image.setTranslateX(image.getTranslateX() + event.getX() - dragX);
            image.setTranslateY(image.getTranslateY() + event.getY() - dragY);
            dragX = event.getX();
            dragY = event.getY();
        });
    }

    void show(Image pixels, double ratio, String information) {
        show(pixels, ratio, new DesktopViewerOverlay.Context(information, "", "", null));
    }

    void show(Image pixels, double ratio, DesktopViewerOverlay.Context information) {
        rowRatio = ratio;
        overlayContext = pixels == null ? null : information;
        topLeft.setText(pixels == null ? "" : information.series());
        bottomLeft.setText(pixels == null ? "" : information.position());
        if (pixels == null) {
            bottomRight.setText("");
            for (Label direction : directions) direction.setText("");
        }
        image.setImage(pixels);
        fit();
    }

    private static Label overlayLabel(Pos alignment) {
        var label = new Label();
        label.getStyleClass().add("image-overlay");
        StackPane.setAlignment(label, alignment);
        StackPane.setMargin(label, new Insets(10, 12, 10, 12));
        return label;
    }

    void message(String title, String detail) {
        prompt.setText(title);
        instructions.setText(detail);
        instructions.setWrapText(true);
        instructions.setMaxWidth(360);
        show(null, 1, "");
    }

    void zoom(double factor) {
        zoom = Math.clamp(zoom * factor, 0.1, 24);
        fit();
    }

    void rotate(int degrees) {
        image.setRotate(Math.floorMod((int) image.getRotate() + degrees, 360));
        fit();
    }

    void center() {
        zoom = 1;
        image.setTranslateX(0);
        image.setTranslateY(0);
        fit();
    }

    void reset() {
        image.setRotate(0);
        adjust(0, 100, false);
        center();
    }

    void overlay(boolean shown) { overlays.setVisible(shown); }

    void adjust(double brightness, double contrast, boolean invert) {
        adjustment.setBrightness(brightness / 100);
        adjustment.setContrast(Math.clamp((contrast - 100) / (contrast >= 100 ? 400 : 80), -1, 1));
        inverted = invert;
        fit();
    }

    Image copy() {
        var parameters = new javafx.scene.SnapshotParameters();
        parameters.setFill(Color.BLACK);
        return image.snapshot(parameters, null);
    }

    private void fit() {
        Image pixels = image.getImage();
        if (pixels == null || getWidth() == 0 || getHeight() == 0) return;
        double width = pixels.getWidth();
        double height = pixels.getHeight() * rowRatio;
        boolean quarterTurn = image.getRotate() % 180 != 0;
        double scale = Math.min(getWidth() / (quarterTurn ? height : width),
                getHeight() / (quarterTurn ? width : height)) * zoom;
        image.setFitWidth(width * scale);
        image.setFitHeight(height * scale);
        if (overlayContext != null) {
            String x = DesktopViewerOverlay.number(scale * 100);
            String y = DesktopViewerOverlay.number(scale * rowRatio * 100);
            String zoomText = "Zoom " + x + "%" + (x.equals(y) ? "" : " × " + y + "%");
            bottomRight.setText(overlayContext.window().isEmpty() ? zoomText : overlayContext.window() + "\n" + zoomText);
            var markers = DesktopViewerOverlay.directions(overlayContext.orientation(), image.getRotate());
            for (int i = 0; i < directions.length; i++) directions[i].setText(markers[i]);
        }
        if (inverted) {
            var white = new ColorInput(0, 0, image.getFitWidth(), image.getFitHeight(), Color.WHITE);
            image.setEffect(new Blend(BlendMode.DIFFERENCE, adjustment, white));
        } else {
            image.setEffect(adjustment);
        }
    }
}
