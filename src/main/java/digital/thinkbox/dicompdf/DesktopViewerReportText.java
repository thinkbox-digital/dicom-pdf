package digital.thinkbox.dicompdf;

import javafx.geometry.Point2D;
import javafx.scene.AccessibleRole;
import javafx.scene.Cursor;
import javafx.scene.shape.Path;
import javafx.scene.text.Text;
import javafx.scene.text.TextFlow;

/** Wrapped report text with selection drawn from JavaFX's own text layout. */
final class DesktopViewerReportText extends TextFlow {
    private final Text text = new Text();
    private final Path highlight = new Path();
    private int first;
    private int last;

    DesktopViewerReportText(String value, String style) {
        getStyleClass().addAll("security-selectable", style);
        text.getStyleClass().add("security-text");
        text.setMouseTransparent(true);
        highlight.getStyleClass().add("security-selection");
        highlight.setManaged(false);
        highlight.setMouseTransparent(true);
        getChildren().addAll(highlight, text);
        setCursor(Cursor.TEXT);
        setAccessibleRole(AccessibleRole.TEXT);
        setMinWidth(0);
        setPickOnBounds(true);
        setText(value);
    }

    void setText(String value) {
        if (text.getText().equals(value)) return;
        setSelection(0, 0);
        text.setText(value);
        setAccessibleText(value);
    }

    String value() { return text.getText(); }

    int position(double sceneX, double sceneY) {
        Point2D local = sceneToLocal(sceneX, sceneY);
        return Math.clamp(hitTest(local).getInsertionIndex(), 0, value().length());
    }

    void setSelection(int start, int end) {
        first = Math.min(start, end);
        last = Math.max(start, end);
        drawSelection();
    }

    String selectedText() { return value().substring(first, last); }

    @Override protected void layoutChildren() {
        super.layoutChildren();
        drawSelection();
    }

    private void drawSelection() {
        if (first == last) highlight.getElements().clear();
        else highlight.getElements().setAll(rangeShape(first, last));
    }
}
