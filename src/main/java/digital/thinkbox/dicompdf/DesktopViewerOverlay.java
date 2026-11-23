package digital.thinkbox.dicompdf;

import java.time.LocalDate;
import java.time.format.DateTimeFormatter;
import java.util.Arrays;
import java.util.Map;
import org.dcm4che3.data.Attributes;
import org.dcm4che3.data.Tag;

final class DesktopViewerOverlay {
    record Detail(double[] orientation, double center, double width, String facility) {}
    record Context(String series, String position, String window, double[] orientation) {}

    private DesktopViewerOverlay() {}

    static Detail detail(Attributes source, int frame, DesktopViewerDocument.Window window, Map<String, String> display) {
        double[] orientation = null;
        if ("BIPED".equalsIgnoreCase(source.getString(Tag.AnatomicalOrientationType, "BIPED"))) {
            var perFrame = source.getNestedDataset(Tag.PerFrameFunctionalGroupsSequence, frame - 1);
            var shared = source.getNestedDataset(Tag.SharedFunctionalGroupsSequence);
            var plane = perFrame == null ? null : perFrame.getNestedDataset(Tag.PlaneOrientationSequence);
            if (plane == null && shared != null) plane = shared.getNestedDataset(Tag.PlaneOrientationSequence);
            orientation = (plane == null ? source : plane).getDoubles(Tag.ImageOrientationPatient);
            if (!valid(orientation)) orientation = null;
        }
        double center = Double.NaN, width = Double.NaN;
        if (source.getString(Tag.PhotometricInterpretation, "").startsWith("MONOCHROME")) {
            if (window != DesktopViewerDocument.INITIAL) {
                center = window.center();
                width = window.width();
            } else if (display != null && display.containsKey("windowCenter") && display.containsKey("windowWidth")) {
                center = Double.parseDouble(display.get("windowCenter"));
                width = Double.parseDouble(display.get("windowWidth"));
            } else {
                var effective = DicomInput.effectiveAttributes(source, frame - 1);
                center = effective.getDouble(Tag.WindowCenter, Double.NaN);
                width = effective.getDouble(Tag.WindowWidth, Double.NaN);
            }
        }
        return new Detail(orientation, center, width, source.getString(Tag.InstitutionName, ""));
    }

    static Context context(Manifest.Image entry, Detail detail, int position, int images, int frame, int frames, String notes) {
        String number = DesktopViewerDocument.field(entry, "SeriesNumber", "");
        String description = DesktopViewerDocument.field(entry, "SeriesDescription", "");
        String series = (number.matches("[+-]?\\d+") ? "Series " + number : "");
        if (!description.isBlank()) {
            var clean = description.replaceAll("[\\p{Cntrl}\\p{Cf}]", " ").strip();
            if (clean.length() > 80) clean = clean.substring(0, 79) + "…";
            series = join(series, clean, " · ");
        }
        String date = date(DesktopViewerDocument.field(entry, "StudyDate", ""));
        if (!date.isBlank()) series = join(series, "Study " + date, "\n");
        String stack = position > 0 && position <= images ? "Image " + position + " of " + images : "";
        if (frames > 1) stack = join(stack, "Frame " + frame + " of " + frames, "\n");
        String level = detail != null && Double.isFinite(detail.center()) && Double.isFinite(detail.width()) && detail.width() > 0
                ? "WL " + number(detail.center()) + " · WW " + number(detail.width()) : "";
        return new Context(join(series, notes, "\n"), stack, level, detail == null ? null : detail.orientation());
    }

    static String date(String text) {
        try { return LocalDate.parse(text.strip(), DateTimeFormatter.BASIC_ISO_DATE).toString(); }
        catch (java.time.DateTimeException invalid) { return ""; }
    }

    static String number(double n) {
        return java.math.BigDecimal.valueOf(n).setScale(3, java.math.RoundingMode.HALF_UP).stripTrailingZeros().toPlainString();
    }

    private static String join(String a, String b, String separator) {
        return a.isBlank() ? b : b.isBlank() ? a : a + separator + b;
    }

    private static boolean valid(double[] values) {
        if (values == null || values.length != 6 || !Arrays.stream(values).allMatch(Double::isFinite)) return false;
        double row = 0, column = 0, dot = 0;
        for (int axis = 0; axis < 3; axis++) {
            row += values[axis] * values[axis];
            column += values[3 + axis] * values[3 + axis];
            dot += values[axis] * values[3 + axis];
        }
        return Math.abs(Math.sqrt(row) - 1) < .001 && Math.abs(Math.sqrt(column) - 1) < .001 && Math.abs(dot) < .001;
    }

    static String[] directions(double[] orientation, double degrees) {
        if (orientation == null) return new String[]{"", "", "", ""};
        double angle = Math.toRadians(degrees), cos = Math.cos(angle), sin = Math.sin(angle);
        double[] right = new double[3], bottom = new double[3];
        for (int axis = 0; axis < 3; axis++) {
            right[axis] = orientation[axis] * cos - orientation[axis + 3] * sin;
            bottom[axis] = orientation[axis] * sin + orientation[axis + 3] * cos;
        }
        return new String[]{direction(bottom, -1), direction(right, 1), direction(bottom, 1), direction(right, -1)};
    }

    private static String direction(double[] vector, int sign) {
        var result = new StringBuilder();
        java.util.stream.IntStream.range(0, 3).boxed()
                .sorted(java.util.Comparator.comparingDouble(axis -> -Math.abs(vector[axis])))
                .filter(axis -> Math.abs(vector[axis]) > .0001)
                .forEach(axis -> result.append((vector[axis] * sign > 0 ? "LPH" : "RAF").charAt(axis)));
        return result.toString();
    }
}
