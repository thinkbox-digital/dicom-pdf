package digital.thinkbox.dicompdf;

import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.util.*;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;
import java.util.function.Consumer;

/** Isolated CLI process: expensive work cannot block the Swing event thread. */
final class DesktopProcess {
    private Process process;
    private CompletableFuture<Void> termination;
    private volatile boolean stopped;
    static List<String> javaCommand(List<String> arguments){return javaCommand(Main.class.getName(),arguments);}
    static List<String> javaCommand(String main,List<String> arguments){
        return javaCommand(main,arguments,null,null);
    }
    static List<String> javaCommand(String main,List<String> arguments,Path scratch,Path stagedInputs){
        String binary=System.getProperty("os.name").toLowerCase(Locale.ROOT).contains("win")?"java.exe":"java";
        var result=new ArrayList<>(List.of(Path.of(System.getProperty("java.home"),"bin",binary).toString(),
                "-Dfile.encoding=UTF-8"));
        String compressionProperty=org.apache.pdfbox.filter.Filter.SYSPROP_DEFLATELEVEL;
        String compression=System.getProperty(compressionProperty);
        if(compression!=null)result.add("-D"+compressionProperty+"="+compression);
        if(scratch!=null)result.add("-Djava.io.tmpdir="+scratch);
        if(stagedInputs!=null)result.add("-D"+DicomPdf.STAGED_INPUTS_PROPERTY+"="+stagedInputs);
        result.addAll(List.of("-cp",System.getProperty("java.class.path"),main));
        result.addAll(arguments);return List.copyOf(result);
    }
    boolean stopped(){return stopped;}
    int execute(List<String> command,Consumer<String> display)throws Exception{
        return execute(command,display,null);
    }
    int execute(List<String> command,Consumer<String> display,char[] password)throws Exception{
        return execute(command,display,password,null);
    }
    int execute(List<String> command,Consumer<String> display,char[] password,Path scratch)throws Exception{
        if(stopped){if(password!=null)Arrays.fill(password,'\0');return 130;}
        Process child;
        try{
            var builder=new ProcessBuilder(command).redirectErrorStream(true);
            if(scratch!=null){
                String path=scratch.toString();
                for(String variable:List.of("DICOMPDF_SCRATCH_DIR","TMPDIR","TMP","TEMP"))
                    builder.environment().put(variable,path);
            }
            child=builder.start();
        }
        catch(Exception failure){if(password!=null)Arrays.fill(password,'\0');throw failure;}
        synchronized(this){
            process=child;
            if(stopped)terminate();
        }
        try(var reader=new InputStreamReader(child.getInputStream(),StandardCharsets.UTF_8)){
            try(var input=child.getOutputStream()){if(password!=null)DesktopPassword.write(input,password);}
            char[] block=new char[4096];int count;
            while((count=reader.read(block))!=-1)display.accept(new String(block,0,count));
            return child.waitFor();
        }catch(Exception error){
            terminate();throw error;
        }finally{
            if(password!=null)Arrays.fill(password,'\0');
            CompletableFuture<Void> finishing;
            synchronized(this){process=null;finishing=termination;termination=null;}
            if(finishing!=null)finishing.join();
        }
    }
    void stop(){
        stopped=true;terminate();
    }
    private synchronized void terminate(){
        Process child=process;if(child==null||termination!=null)return;
        termination=CompletableFuture.runAsync(()->{
            List<ProcessHandle> descendants=child.descendants().toList();
            descendants.forEach(ProcessHandle::destroy);child.destroy();
            try{child.waitFor(2,TimeUnit.SECONDS);}catch(InterruptedException error){Thread.currentThread().interrupt();}
            descendants.stream().filter(ProcessHandle::isAlive).forEach(ProcessHandle::destroyForcibly);
            if(child.isAlive())child.destroyForcibly();
            child.onExit().join();
            CompletableFuture.allOf(descendants.stream().filter(ProcessHandle::isAlive)
                    .map(ProcessHandle::onExit).toArray(CompletableFuture<?>[]::new)).completeOnTimeout(null,2,TimeUnit.SECONDS).join();
        },task->Thread.ofPlatform().daemon().name("dicom-desktop-stop").start(task));
    }
}
