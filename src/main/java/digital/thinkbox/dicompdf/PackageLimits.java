package digital.thinkbox.dicompdf;

import java.io.IOException;
import java.io.OutputStream;
import java.util.Objects;

/** Overflow-safe byte accounting; production archival streams have no fixed size cap. */
final class PackageLimits {
    static final long PAYLOAD = Long.MAX_VALUE;
    static final long ATTACHMENTS = Long.MAX_VALUE;
    static final long DOCUMENT = Long.MAX_VALUE;

    private PackageLimits() {}

    static OutputStream documentOutput(OutputStream destination, long limit) {
        Objects.requireNonNull(destination);
        if (limit < 1) throw new IllegalArgumentException("Invalid document limit");
        return new OutputStream() {
            long written;
            private void check(int length) throws IOException {
                if (length > limit - written) throw new IOException("Generated PDF exceeds the configured viewer limit; output was not published");
            }
            @Override public void write(int value) throws IOException {
                check(1);destination.write(value);written++;
            }
            @Override public void write(byte[] value, int offset, int length) throws IOException {
                Objects.checkFromIndexSize(offset,length,value.length);
                check(length);destination.write(value,offset,length);written+=length;
            }
            @Override public void flush() throws IOException { destination.flush(); }
            @Override public void close() throws IOException { destination.close(); }
        };
    }

    static long reserve(long total, long size) throws IOException {
        if (total < 0 || size < 0)
            throw new IOException("Invalid embedded payload byte length");
        if (size > ATTACHMENTS - total)
            throw new IOException("Combined byte length cannot be represented");
        return total + size;
    }
}
