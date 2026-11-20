package digital.thinkbox.dicompdf;

import java.util.Locale;
import java.util.regex.Pattern;

/** Bounded parsing of streamed output, including split lines and long runs. Used on the Swing thread. */
final class DesktopActivity {
    private static final int LINE_LIMIT=8192;
    private static final Pattern COUNTS=Pattern.compile(": \\d+ supplied and embedded; \\d+ displayed; \\d+ rejected for display\\.");
    private final long started;
    private long lastNotice;
    private final StringBuilder pending=new StringBuilder();
    private String phase="Preparing selected inputs…",creationSummary="";
    DesktopActivity(long now){started=lastNotice=now;}
    void accept(String chunk,long now){
        lastNotice=now;
        for(int i=0;i<chunk.length();i++){
            char value=chunk.charAt(i);
            if(value=='\n'){
                String line=pending.toString().strip();pending.setLength(0);
                if(line.startsWith("Progress: "))phase=line.substring("Progress: ".length());
                if(line.startsWith("Created ")&&COUNTS.matcher(line).find())creationSummary=line;
            }else{
                if(pending.length()==LINE_LIMIT)pending.delete(0,LINE_LIMIT/2);
                pending.append(value);
            }
        }
    }
    String phase(){return phase;}
    String creationSummary(){return creationSummary;}
    String elapsed(long now){long seconds=Math.max(0,(now-started)/1_000_000_000L);return String.format(Locale.ROOT,"%02d:%02d",seconds/60,seconds%60);}
    String heartbeat(long now){
        if(now-lastNotice<10_000_000_000L)return "";
        lastNotice=now;return "Still running ("+elapsed(now)+" elapsed): "+phase+"\n";
    }
}
