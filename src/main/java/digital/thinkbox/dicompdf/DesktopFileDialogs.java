package digital.thinkbox.dicompdf;

import java.nio.file.*;
import java.util.*;
import javax.swing.JFileChooser;
import java.util.prefs.Preferences;

/** Remember directories per chooser purpose, with a shared fallback for new fields. */
final class DesktopFileDialogs {
    private final Map<String,String> memory;
    private final boolean persistent;
    DesktopFileDialogs(){memory=new HashMap<>();persistent=true;}
    DesktopFileDialogs(Map<String,String> memory){this.memory=memory;persistent=false;}
    JFileChooser chooser(String purpose,String selection){
        return chooser(purpose,selection,null);
    }
    JFileChooser chooser(String purpose,String selection,Path initial){
        String folder=read(purpose);
        if(folder==null&&initial!=null&&Files.isDirectory(initial))folder=initial.toAbsolutePath().normalize().toString();
        if(folder==null)folder=read("lastDirectory");
        JFileChooser chooser=folder!=null&&Files.isDirectory(Path.of(folder))?new JFileChooser(folder):new JFileChooser();
        if(selection!=null&&!selection.isBlank()){
            Path path=Path.of(selection.strip()).toAbsolutePath().normalize();
            Path parent=path.getParent();if(parent!=null&&Files.isDirectory(parent))chooser.setCurrentDirectory(parent.toFile());
            chooser.setSelectedFile(path.toFile());
        }
        return chooser;
    }
    void remember(String purpose,JFileChooser chooser){
        if(chooser.getCurrentDirectory()==null)return;
        String folder=chooser.getCurrentDirectory().toPath().toAbsolutePath().normalize().toString();
        write(purpose,folder);write("lastDirectory",folder);
    }
    private String read(String key){
        if(persistent)try{return preferences().get(key,memory.get(key));}catch(SecurityException ignored){}
        return memory.get(key);
    }
    private void write(String key,String value){
        memory.put(key,value);
        if(persistent)try{var preferences=preferences();preferences.put(key,value);preferences.flush();}catch(SecurityException|java.util.prefs.BackingStoreException ignored){}
    }
    private static Preferences preferences(){return Preferences.userNodeForPackage(ArchiveDesktop.class).node("fileDialogs");}
}
